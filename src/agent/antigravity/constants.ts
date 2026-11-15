export { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-cli";

export const AntigravityError = {
	NotSignedIn: "Antigravity CLI is not authenticated. Please run 'antigravity' in your terminal to sign in.",
	StartupFailed: "Antigravity CLI failed to start. Verify your installation and try again.",
	MinimumVersionRequired: "Antigravity CLI requires an update.",
} as const;
