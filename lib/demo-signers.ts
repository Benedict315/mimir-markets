export type DemoWriteAction = "create_claim" | "create_rematch" | "challenge_claim";

type DemoSignerEnv = Record<string, string | undefined>;

export function getDemoSecret(
  action: string,
  env: DemoSignerEnv = process.env,
): string | undefined {
  if (action === "create_claim" || action === "create_rematch") {
    return (
      env.DEMO_CREATOR_STELLAR_SECRET ||
      env.DEMO_CREATOR_SECRET ||
      env.DEMO_SIGNER_STELLAR_SECRET ||
      env.DEMO_SIGNER_SECRET ||
      env.DEMO_CREATOR_PRIVATE_KEY ||
      env.DEMO_SIGNER_PRIVATE_KEY
    );
  }

  if (action === "challenge_claim") {
    return (
      env.DEMO_CHALLENGER_STELLAR_SECRET ||
      env.DEMO_CHALLENGER_SECRET ||
      env.DEMO_SIGNER_STELLAR_SECRET ||
      env.DEMO_SIGNER_SECRET ||
      env.DEMO_CHALLENGER_PRIVATE_KEY ||
      env.DEMO_SIGNER_PRIVATE_KEY
    );
  }

  return undefined;
}