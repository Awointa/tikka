/**
 * Contract Configuration
 *
 * Configuration for Soroban raffle smart contract interactions
 */

/** Player count above which a raffle is considered "Trending". */
export const TRENDING_PLAYER_THRESHOLD = 50;

/**
 * How long a fetched player count is considered fresh (ms).
 * Counts are re-fetched after this TTL on the next arcade page load.
 * Default: 60 seconds — balances freshness vs RPC call volume.
 */
export const PLAYER_COUNT_CACHE_TTL_MS = 60_000;

import { env } from "./env";
import { STELLAR_CONFIG } from "./stellar";

/**
 * Contract configuration object
 */
export const CONTRACT_CONFIG = {
    // Contract address from environment (TBD initially)
    address: env.soroban.contractAddress || "TBD",
    
    // Network configuration
    network: STELLAR_CONFIG.network,
    networkPassphrase: STELLAR_CONFIG.networkPassphrase,
    
    // RPC configuration
    rpcUrl: STELLAR_CONFIG.rpcUrl,
    
    // Contract deployment hash (optional, for reference)
    deploymentHash: env.soroban.deploymentHash,
    
    // Contract function names
    functions: {
        // Read functions
        getRaffleData: "get_raffle_data",
        getActiveRaffleIds: "get_active_raffle_ids", 
        getAllRaffleIds: "get_all_raffle_ids",
        getUserParticipation: "get_user_raffle_participation",
        
        // Write functions
        createRaffle: "create_raffle",
        buyTicket: "buy_ticket",
    } as const,
    
    // Contract constants
    constants: {
        // Minimum ticket price in stroops (0.1 XLM)
        minTicketPrice: 1000000,
        
        // Maximum tickets per raffle
        maxTickets: 10000,
        
        // Minimum raffle duration in seconds (1 hour)
        minDuration: 3600,
        
        // Maximum raffle duration in seconds (30 days)
        maxDuration: 2592000,
    } as const,
} as const;

/**
 * Contract function names type
 */
export type ContractFunction = typeof CONTRACT_CONFIG.functions[keyof typeof CONTRACT_CONFIG.functions];

/**
 * Validate contract configuration
 */
export function validateContractConfig(): void {
    if (!CONTRACT_CONFIG.rpcUrl) {
        throw new Error("Missing Soroban RPC URL in contract configuration");
    }
    
    if (CONTRACT_CONFIG.address === "TBD") {
        console.warn("⚠️ Contract address is TBD - contract interactions will fail until deployed");
    }
    
    console.log("📋 Contract Configuration:", {
        address: CONTRACT_CONFIG.address,
        network: CONTRACT_CONFIG.network,
        rpcUrl: CONTRACT_CONFIG.rpcUrl,
    });
}

// Validate configuration on module load
validateContractConfig();