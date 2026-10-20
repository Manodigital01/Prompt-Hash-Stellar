#![cfg(test)]

//! Two-step contract ownership transfer with pending acceptance and expiry
//! (#1034).
//!
//! `PromptHashContract` exposes OpenZeppelin's `Ownable` trait unchanged, so
//! these tests pin the guarantees this contract relies on: the current owner
//! keeps full control until the pending owner accepts, the acceptance deadline
//! (`live_until_ledger`) is enforced from the stored value rather than the
//! temporary-entry TTL, and every mutation is bound to the right signer.

use crate::contract::{PromptHashContract, PromptHashContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    Address, Env, Error, IntoVal,
};

// stellar-access error codes (ownable/mod.rs, role_transfer/mod.rs).
const TRANSFER_IN_PROGRESS: u32 = 2101;
const NO_PENDING_TRANSFER: u32 = 2200;
const INVALID_LIVE_UNTIL_LEDGER: u32 = 2201;
const INVALID_PENDING_ACCOUNT: u32 = 2202;
const TRANSFER_EXPIRED: u32 = 2203;

const ACCEPT_WINDOW: u32 = 100;

struct Ctx {
    env: Env,
    owner: Address,
    client: PromptHashContractClient<'static>,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.ledger().set_sequence_number(1_000);
    let owner = Address::generate(&env);
    let contract = env.register(
        PromptHashContract,
        (
            owner.clone(),
            Address::generate(&env),
            Address::generate(&env),
        ),
    );
    let client = PromptHashContractClient::new(&env, &contract);
    Ctx { env, owner, client }
}

fn contract_error(code: u32) -> Error {
    Error::from_contract_error(code)
}

fn deadline(env: &Env) -> u32 {
    env.ledger().sequence() + ACCEPT_WINDOW
}

/// The last authorization tree recorded by the host was signed by `signer`.
fn assert_signed_by(env: &Env, signer: &Address) {
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(&auths[0].0, signer);
}

#[test]
fn pending_owner_accepts_within_window() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);

    ctx.client
        .transfer_ownership(&new_owner, &deadline(&ctx.env));
    assert_signed_by(&ctx.env, &ctx.owner);
    // Initiating a transfer does not revoke the current owner's control.
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
    ctx.client.set_pause_status(&true);
    assert_signed_by(&ctx.env, &ctx.owner);

    ctx.client.accept_ownership();
    assert_signed_by(&ctx.env, &new_owner);
    assert_eq!(ctx.client.get_owner(), Some(new_owner.clone()));

    // Owner-gated entrypoints now require the new owner's signature.
    ctx.client.set_pause_status(&false);
    assert_signed_by(&ctx.env, &new_owner);
}

#[test]
fn acceptance_is_allowed_on_the_deadline_ledger() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);
    let live_until = deadline(&ctx.env);

    ctx.client.transfer_ownership(&new_owner, &live_until);
    ctx.env.ledger().set_sequence_number(live_until);

    ctx.client.accept_ownership();
    assert_eq!(ctx.client.get_owner(), Some(new_owner));
}

#[test]
fn acceptance_after_deadline_fails_once_the_pending_entry_expired() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);
    let live_until = deadline(&ctx.env);

    ctx.client.transfer_ownership(&new_owner, &live_until);
    // The pending entry's TTL ends exactly at the deadline, so one ledger
    // later the temporary entry is gone.
    ctx.env.ledger().set_sequence_number(live_until + 1);

    assert_eq!(
        ctx.client.try_accept_ownership(),
        Err(Ok(contract_error(NO_PENDING_TRANSFER)))
    );
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
}

#[test]
fn deadline_is_enforced_even_when_the_pending_entry_outlives_it() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    // Networks give temporary entries a minimum TTL that can exceed a short
    // acceptance window (and anyone may extend a TTL). Temporary storage is
    // not a time-limit mechanism, so the stored deadline must still apply.
    ctx.env.ledger().set_min_temp_entry_ttl(ACCEPT_WINDOW * 10);
    let new_owner = Address::generate(&ctx.env);
    let live_until = deadline(&ctx.env);

    ctx.client.transfer_ownership(&new_owner, &live_until);
    ctx.env.ledger().set_sequence_number(live_until + 1);

    assert_eq!(
        ctx.client.try_accept_ownership(),
        Err(Ok(contract_error(TRANSFER_EXPIRED)))
    );
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
}

#[test]
fn owner_can_retry_after_expiry_with_a_fresh_deadline() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);
    let first_deadline = deadline(&ctx.env);

    ctx.client.transfer_ownership(&new_owner, &first_deadline);
    ctx.env.ledger().set_sequence_number(first_deadline + 1);
    assert!(ctx.client.try_accept_ownership().is_err());

    ctx.client
        .transfer_ownership(&new_owner, &deadline(&ctx.env));
    ctx.client.accept_ownership();
    assert_eq!(ctx.client.get_owner(), Some(new_owner));
}

#[test]
fn cancelled_transfer_cannot_be_accepted() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);

    ctx.client
        .transfer_ownership(&new_owner, &deadline(&ctx.env));
    ctx.client.transfer_ownership(&new_owner, &0);

    assert_eq!(
        ctx.client.try_accept_ownership(),
        Err(Ok(contract_error(NO_PENDING_TRANSFER)))
    );
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
}

#[test]
fn cancel_must_name_the_pending_account() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);
    let other = Address::generate(&ctx.env);

    assert_eq!(
        ctx.client.try_transfer_ownership(&new_owner, &0),
        Err(Ok(contract_error(NO_PENDING_TRANSFER)))
    );

    ctx.client
        .transfer_ownership(&new_owner, &deadline(&ctx.env));
    assert_eq!(
        ctx.client.try_transfer_ownership(&other, &0),
        Err(Ok(contract_error(INVALID_PENDING_ACCOUNT)))
    );
}

#[test]
fn deadline_must_be_within_current_and_max_ttl_ledgers() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);
    let current = ctx.env.ledger().sequence();
    let max_live_until = ctx.env.ledger().max_live_until_ledger();

    assert_eq!(
        ctx.client
            .try_transfer_ownership(&new_owner, &(current - 1)),
        Err(Ok(contract_error(INVALID_LIVE_UNTIL_LEDGER)))
    );
    assert_eq!(
        ctx.client
            .try_transfer_ownership(&new_owner, &(max_live_until + 1)),
        Err(Ok(contract_error(INVALID_LIVE_UNTIL_LEDGER)))
    );
}

#[test]
fn newer_transfer_replaces_the_pending_recipient() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let first = Address::generate(&ctx.env);
    let second = Address::generate(&ctx.env);

    ctx.client.transfer_ownership(&first, &deadline(&ctx.env));
    ctx.client.transfer_ownership(&second, &deadline(&ctx.env));

    ctx.client.accept_ownership();
    assert_signed_by(&ctx.env, &second);
    assert_eq!(ctx.client.get_owner(), Some(second));
}

#[test]
fn non_owner_cannot_initiate_transfer() {
    let ctx = setup();
    let attacker = Address::generate(&ctx.env);
    let live_until = deadline(&ctx.env);

    ctx.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &ctx.client.address,
            fn_name: "transfer_ownership",
            args: (attacker.clone(), live_until).into_val(&ctx.env),
            sub_invokes: &[],
        },
    }]);

    assert!(ctx
        .client
        .try_transfer_ownership(&attacker, &live_until)
        .is_err());
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
}

#[test]
fn only_the_pending_owner_can_accept() {
    let ctx = setup();
    let new_owner = Address::generate(&ctx.env);
    let attacker = Address::generate(&ctx.env);
    ctx.env.mock_all_auths();
    ctx.client
        .transfer_ownership(&new_owner, &deadline(&ctx.env));

    ctx.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &ctx.client.address,
            fn_name: "accept_ownership",
            args: ().into_val(&ctx.env),
            sub_invokes: &[],
        },
    }]);

    assert!(ctx.client.try_accept_ownership().is_err());
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
}

#[test]
fn renounce_is_blocked_while_a_transfer_is_pending() {
    let ctx = setup();
    ctx.env.mock_all_auths();
    let new_owner = Address::generate(&ctx.env);

    ctx.client
        .transfer_ownership(&new_owner, &deadline(&ctx.env));

    assert_eq!(
        ctx.client.try_renounce_ownership(),
        Err(Ok(contract_error(TRANSFER_IN_PROGRESS)))
    );
    assert_eq!(ctx.client.get_owner(), Some(ctx.owner.clone()));
}
