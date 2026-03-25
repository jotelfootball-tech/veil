import { useState, useEffect } from 'react';
import {
    Contract,
    Keypair,
    SorobanRpc,
    TransactionBuilder,
    BASE_FEE,
    xdr,
    nativeToScVal,
} from 'stellar-sdk';
import {
    bufferToHex,
    hexToUint8Array,
    derToRawSignature,
    extractP256PublicKey,
    computeWalletAddress,
} from './utils';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Configuration passed when mounting the hook.
 * Keeping these at hook level (rather than per-method) lets the caller set them
 * once and have every method — deploy, sign, etc. — share the same network context.
 */
export type WalletConfig = {
    /** The factory contract's Stellar strkey (e.g. "CABC..."). */
    factoryAddress: string;
    /** Stellar Horizon-compatible RPC endpoint (e.g. "https://soroban-testnet.stellar.org"). */
    rpcUrl: string;
    /** Stellar network passphrase. Use Networks.TESTNET or Networks.PUBLIC. */
    networkPassphrase: string;
};

/**
 * The four pieces the contract's __check_auth needs to verify a WebAuthn assertion.
 */
export type WebAuthnSignature = {
    /** Uncompressed P-256 public key: 0x04 x y (65 bytes) */
    publicKey: Uint8Array;
    /** Raw authenticatorData bytes from the WebAuthn assertion response */
    authData: Uint8Array;
    /** Raw clientDataJSON bytes */
    clientDataJSON: Uint8Array;
    /** Raw P-256 ECDSA signature: r s (64 bytes) */
    signature: Uint8Array;
};

/** Result returned by a successful register() call. */
export type RegisterResult = {
    /** The deterministically computed contract address of the new wallet ("C..."). */
    walletAddress: string;
};

/** Result returned by a successful deploy() call. */
export type DeployResult = {
    /** The on-chain contract address of the deployed wallet ("C..."). */
    walletAddress: string;
    /**
     * True if the wallet was already deployed before this call.
     * When true, no transaction was submitted.
     */
    alreadyDeployed: boolean;
};

type InvisibleWallet = {
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: string | null;
    /** True if the wallet contract has been confirmed to exist on-chain. */
    isDeployed: boolean;
    isPending: boolean;
    error: string | null;
    /** Create a new passkey credential and compute the deterministic wallet address. */
    register: (username: string) => Promise<RegisterResult>;
    /**
     * Deploy the user's wallet contract on-chain via the factory.
     *
     * Reads the P-256 public key stored by a prior register() call and submits
     * a Soroban transaction to the factory contract. If the wallet is already
     * deployed, returns the existing address without submitting a new transaction.
     *
     * @param signerKeypair  A traditional Stellar Keypair used as the transaction
     *                       fee source. Separate from the passkey — pays fees only,
     *                       does not control the wallet.
     * @param publicKeyBytes Optional override for the P-256 public key. Defaults to
     *                       the key stored in localStorage by register().
     * @returns The deployed wallet's contract address and whether it was already live.
     */
    deploy: (signerKeypair: Keypair, publicKeyBytes?: Uint8Array) => Promise<DeployResult>;
    /**
     * Sign a Soroban authorization entry using the stored passkey.
     *
     * @param signaturePayload  The 32-byte payload from the Soroban SorobanAuthorizationEntry.
     */
    signAuthEntry: (signaturePayload: Uint8Array) => Promise<WebAuthnSignature | null>;
    /**
     * Restore an existing wallet session from localStorage.
     * Verifies that the wallet contract actually exists on-chain before setting the address.
     */
    login: () => Promise<void>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 1_000;
const POLL_MAX_ATTEMPTS = 30;

/**
 * Poll server.getTransaction(hash) until the transaction leaves NOT_FOUND,
 * then return the final result. Throws if it fails or we exceed the attempt limit.
 */
async function waitForTransaction(
    server: SorobanRpc.Server,
    hash: string
): Promise<SorobanRpc.Api.GetTransactionResponse> {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        const result = await server.getTransaction(hash);
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            return result;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Transaction ${hash} not confirmed after ${POLL_MAX_ATTEMPTS} attempts`);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useInvisibleWallet(config: WalletConfig): InvisibleWallet {
    const { factoryAddress, rpcUrl, networkPassphrase } = config;

    const [address, setAddress] = useState<string | null>(null);
    const [isDeployed, setIsDeployed] = useState(false);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const stored = localStorage.getItem('invisible_wallet_address');
        if (stored) setAddress(stored);
    }, []);

    // ── register ──────────────────────────────────────────────────────────────

    const register = async (username: string): Promise<RegisterResult> => {
        setIsPending(true);
        setError(null);
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));

            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: 'Invisible Wallet' },
                    user: {
                        id: new TextEncoder().encode(username),
                        name: username,
                        displayName: username,
                    },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                    timeout: 60_000,
                    authenticatorSelection: {
                        residentKey: 'preferred',
                        userVerification: 'required',
                    },
                },
            }) as PublicKeyCredential;

            if (!credential) throw new Error('Credential creation failed');

            const response = credential.response as AuthenticatorAttestationResponse;
            const publicKeyBytes = await extractP256PublicKey(response);
            const publicKeyHex = bufferToHex(publicKeyBytes);

            const walletAddress = computeWalletAddress(factoryAddress, publicKeyBytes, networkPassphrase);

            localStorage.setItem('invisible_wallet_address',    walletAddress);
            localStorage.setItem('invisible_wallet_key_id',     credential.id);
            localStorage.setItem('invisible_wallet_public_key', publicKeyHex);
            setAddress(walletAddress);

            return { walletAddress };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    // ── deploy ────────────────────────────────────────────────────────────────

    const deploy = async (
        signerKeypair: Keypair,
        publicKeyBytes?: Uint8Array
    ): Promise<DeployResult> => {
        setIsPending(true);
        setError(null);
        try {
            // Resolve the public key — prefer explicit param, fall back to localStorage.
            let pubKeyBytes = publicKeyBytes;
            if (!pubKeyBytes) {
                const hex = localStorage.getItem('invisible_wallet_public_key');
                if (!hex) throw new Error(
                    'No public key found. Call register() first, or pass publicKeyBytes explicitly.'
                );
                pubKeyBytes = hexToUint8Array(hex);
            }

            // Pre-compute the deterministic address so we can guard against re-deployment
            // and update local state the moment the tx confirms — without parsing the
            // contract return value.
            const walletAddress = computeWalletAddress(factoryAddress, pubKeyBytes, networkPassphrase);

            const server = new SorobanRpc.Server(rpcUrl);

            // ── Guard: already deployed? ──────────────────────────────────────
            // Attempt to fetch the contract's instance ledger entry. If it exists,
            // the wallet is already live and we return early without a duplicate tx.
            try {
                await server.getContractData(
                    walletAddress,
                    xdr.ScVal.scvLedgerKeyContractInstance(),
                    SorobanRpc.Durability.Persistent
                );
                // Reached here → entry found → already deployed.
                setAddress(walletAddress);
                setIsDeployed(true);
                localStorage.setItem('invisible_wallet_address', walletAddress);
                return { walletAddress, alreadyDeployed: true };
            } catch (e: unknown) {
                // Only proceed if the entry was genuinely absent.
                // Any other error (network failure, RPC down) should bubble up.
                const msg = e instanceof Error ? e.message : String(e);
                if (!msg.toLowerCase().includes('not found')) throw e;
            }

            // ── Build transaction ─────────────────────────────────────────────
            // The factory's `deploy` function receives the raw P-256 public key bytes
            // and uses SHA-256(bytes) as the salt to derive the wallet address on-chain.
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const factory = new Contract(factoryAddress);

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    factory.call('deploy', nativeToScVal(pubKeyBytes, { type: 'bytes' }))
                )
                .setTimeout(30)
                .build();

            // ── Simulate → discover footprint + resource fees ─────────────────
            // Soroban requires simulation before submission. The simulation tells the
            // network which ledger entries (storage keys) this tx reads and writes.
            // Without it, the node rejects the transaction outright.
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            // ── Assemble → injects soroban data + accurate fee into the tx ────
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            assembled.sign(signerKeypair);

            // ── Submit ────────────────────────────────────────────────────────
            const sendResult = await server.sendTransaction(assembled);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            // ── Poll for confirmation ─────────────────────────────────────────
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            setAddress(walletAddress);
            setIsDeployed(true);
            localStorage.setItem('invisible_wallet_address', walletAddress);
            return { walletAddress, alreadyDeployed: false };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    // ── login ─────────────────────────────────────────────────────────────────

    const login = async () => {
        setIsPending(true);
        setError(null);
        try {
            const stored = localStorage.getItem('invisible_wallet_address');
            if (!stored) {
                setError('No wallet found. Please register first.');
                return;
            }

            const server = new SorobanRpc.Server(rpcUrl);

            // Verify the wallet actually exists on-chain before restoring session
            try {
                await server.getContractData(
                    stored,
                    xdr.ScVal.scvLedgerKeyContractInstance(),
                    SorobanRpc.Durability.Persistent
                );
                // Reached here → entry found → already deployed.
                setAddress(stored);
                setIsDeployed(true);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes('not found')) {
                    setError('Wallet not yet deployed. Call deploy() to create it on-chain.');
                    setAddress(null);
                    setIsDeployed(false);
                } else {
                    throw e; // Real network error
                }
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsPending(false);
        }
    };

    // ── signAuthEntry ─────────────────────────────────────────────────────────

    const signAuthEntry = async (
        signaturePayload: Uint8Array
    ): Promise<WebAuthnSignature | null> => {
        setIsPending(true);
        setError(null);
        try {
            const keyId        = localStorage.getItem('invisible_wallet_key_id');
            const publicKeyHex = localStorage.getItem('invisible_wallet_public_key');
            if (!keyId)        throw new Error('No key ID found. Please register first.');
            if (!publicKeyHex) throw new Error('No public key found. Please register first.');

            if (signaturePayload.length !== 32) {
                throw new Error('signaturePayload must be exactly 32 bytes');
            }

            const challenge = signaturePayload.buffer.slice(
                signaturePayload.byteOffset,
                signaturePayload.byteOffset + signaturePayload.byteLength
            ) as ArrayBuffer;

            const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'));
            const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0));

            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge,
                    allowCredentials: [{ id: credId, type: 'public-key' }],
                    userVerification: 'required',
                },
            }) as PublicKeyCredential;

            if (!assertion) throw new Error('Signing was cancelled');

            const response = assertion.response as AuthenticatorAssertionResponse;
            const rawSignature = derToRawSignature(response.signature);
            const publicKeyBytes = hexToUint8Array(publicKeyHex);

            return {
                publicKey:      publicKeyBytes,
                authData:       new Uint8Array(response.authenticatorData),
                clientDataJSON: new Uint8Array(response.clientDataJSON),
                signature:      rawSignature,
            };

        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
            return null;
        } finally {
            setIsPending(false);
        }
    };

    return { address, isDeployed, isPending, error, register, deploy, signAuthEntry, login };
}
