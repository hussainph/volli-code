import type { SecretRequestMetadata } from "@volli/shared";

export interface SecretWaitPublisher {
  opened(metadata: SecretRequestMetadata): Promise<void>;
  settled(
    metadata: SecretRequestMetadata,
    outcome: "signed in" | "declined" | "still missing",
  ): Promise<void>;
}
