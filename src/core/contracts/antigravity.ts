export const ANTIGRAVITY_PROVIDER = "antigravity";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface AntigravityStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

export const ANTIGRAVITY_MINIMUM_VERSION = "1.0.0";
