/** TEST-ONLY: publish a real Pi text delta, then hold the provider's finish. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { scriptedProvider } from "./scripted-provider";

export function gatedProvider(text = "Streaming reply") {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const script = scriptedProvider([{ text }]);
  const provider = script.models.getProvider("scripted-fixture")!;
  const stream = provider.streamSimple!;
  script.models.setProvider({
    ...provider,
    streamSimple: (...args) => {
      const upstream = stream(...args);
      const output = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of upstream) {
          output.push(event);
          if (event.type === "text_delta") {
            entered.resolve();
            await release.promise;
          }
        }
        output.end(await upstream.result());
      })();
      return output;
    },
  });
  return { ...script, entered: entered.promise, release: release.resolve };
}
