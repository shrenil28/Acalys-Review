import { ProviderError, ValidationError } from "@acalys/contracts/domain";
import { z } from "zod";

const meSchema = z.object({
  id: z.string().min(1).max(200),
  login: z.string().min(1).max(500),
  name: z.string().max(500).nullable().optional(),
});

export class CircleCiIntegrationService {
  public constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  public async verifyToken(token: string): Promise<{
    readonly id: string;
    readonly login: string;
    readonly name?: string | undefined;
  }> {
    if (token.trim() === "" || token.length > 8_192)
      throw new ValidationError("CircleCI token is invalid");
    const response = await this.fetchImpl("https://circleci.com/api/v2/me", {
      headers: { "Circle-Token": token, accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) {
      throw new ProviderError("CircleCI token identity verification failed", {
        retryable: response.status >= 500,
      });
    }
    const parsed = meSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ProviderError(
        "CircleCI identity response had an invalid shape",
        { retryable: false },
      );
    }
    return {
      id: parsed.data.id,
      login: parsed.data.login,
      ...(parsed.data.name == null ? {} : { name: parsed.data.name }),
    };
  }
}
