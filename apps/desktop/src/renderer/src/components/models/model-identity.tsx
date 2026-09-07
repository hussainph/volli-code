/**
 * A model as a thing you recognise rather than a string you read.
 *
 * Every model surface — Settings rows, the composer pill, the picker list, an
 * Automation's runtime chip — was rendering `label · Provider` as one run of
 * body text. Twelve of those in a column are twelve grey lines; the one fact a
 * person is scanning for (which family is this?) is buried in the middle of
 * each. A mark the eye catches before the word is read fixes that in every
 * place at once.
 *
 * **The mark says WHAT the model is; the text says WHERE it is billed.** The
 * reference this ticket attached (OMP's Task models) puts OpenAI's knot beside
 * GPT, Anthropic's mark beside Claude, Gemini's spark beside Gemini — a mark per
 * *family*, not per account. That is the honest reading of the catalog too:
 * "Claude Opus 4.5" from GitHub Copilot is still a Claude model; Copilot is
 * who invoices it. So the mark is chosen by family (from the model's id and
 * label), the provider appears as text only where the composer's own rule says
 * it must (`modelPillLabel`: when the same name ships from two signed-in
 * providers, or the model is not in the list), and a provider that is an
 * aggregator with no family of its own (OpenRouter, Copilot) wears its own
 * mark only when the family cannot be told. `markBy="provider"` flips that
 * order so the two can be judged side by side in the Lab.
 *
 * These are the vendors' real marks, lifted verbatim (paths and viewBox) from
 * simple-icons (CC0 1.0), the same source `harness-identity.tsx` uses. The
 * trademarks remain their owners'; they identify a model the user chose.
 * Nothing here is drawn by hand — except the FALLBACK, which is not a logo: a
 * lettermark in a muted rounded square, so a family with no mark in this file
 * (Grok, GLM, DeepSeek, the long tail of 39 providers) still occupies the same
 * footprint on the same axis as its neighbours and the column stays a column.
 *
 * The tints are `MODEL_MARK_TINTS` in `@volli/shared`, where CLAUDE.md keeps
 * TypeScript-consumable domain colours: they follow the harness file's rule —
 * low-chroma, brand-adjacent, off-ember — because Claude's own coral would sit
 * on Volli's accent, and a family colour that reads as the app's own colour is
 * worse than none. Everything else here is generated tokens.
 *
 * One module for every surface — the composer pill and its list, the New-ticket
 * Create & start row, the Settings rows — so they agree on one drawing. The
 * marks are inline path data rather than SVG files: the renderer's CSP allows
 * no external origins, and an inline `<svg>` takes `currentColor`, a tint and a
 * size like any other glyph in the app.
 */
import { MODEL_MARK_TINTS } from "@volli/shared";
import type { ModelAccessModel, ModelAccessProvider } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

export type MarkBy = "family" | "provider";

/**
 * Which mark leads when a model has both: the account's (Anthropic's A) or
 * the family's (Claude's starburst). The owner chose the provider's in the
 * VC-259 Lab review — the mark then says who is billed, which is the fact a
 * person setting defaults is actually deciding. The family still fills in
 * for providers with no mark of their own (the OpenAI knot on a GPT from a
 * gateway that has none), so a row is never markless when it need not be.
 */
export const DEFAULT_MARK_BY: MarkBy = "provider";

interface Mark {
  paths: readonly string[];
  viewBox: string;
  tint: string;
}

/** Families a model id or label can be read as. */
type Family = "claude" | "openai" | "gemini" | "deepseek" | "mistral" | "llama" | "qwen";

const FAMILY_MARK: Record<Family, Mark> = {
  claude: {
    // Claude's starburst (simple-icons `claude`).
    paths: [
      "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.claude,
  },
  openai: {
    // OpenAI's knot (simple-icons `openai`).
    paths: [
      "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.openai,
  },
  gemini: {
    // Gemini's four-point spark (simple-icons `googlegemini`).
    paths: [
      "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.gemini,
  },
  deepseek: {
    // DeepSeek's whale (simple-icons `deepseek`). Dense; reads a shade heavier than its neighbours.
    paths: [
      "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.deepseek,
  },
  mistral: {
    // Mistral's block glyph (simple-icons `mistralai`). Dense.
    paths: [
      "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.mistral,
  },
  llama: {
    // Meta's mark (simple-icons `meta`), for the Llama family.
    paths: [
      "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.llama,
  },
  qwen: {
    // Alibaba Cloud's mark (simple-icons `alibabacloud`), for the Qwen family.
    paths: [
      "M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.qwen,
  },
};

/** Providers with a mark of their own. First-party vendors reuse the family's. */
const PROVIDER_MARK: Record<string, Mark> = {
  anthropic: {
    // Anthropic's A (simple-icons `anthropic`) — the company, not the model.
    paths: [
      "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
    ],
    viewBox: "0 0 24 24",
    tint: FAMILY_MARK.claude.tint,
  },
  openai: FAMILY_MARK.openai,
  "openai-codex": FAMILY_MARK.openai,
  "azure-openai-responses": FAMILY_MARK.openai,
  "github-copilot": {
    // Copilot's goggles (simple-icons `githubcopilot`). Monochrome in every
    // vendor rendering, so it gets the neutral, like Cursor's cube does.
    paths: [
      "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.monochrome,
  },
  google: {
    // Google's G (simple-icons `google`) — the account, not the Gemini family. Thin; reads a shade lighter.
    paths: [
      "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.google,
  },
  huggingface: {
    // Hugging Face (simple-icons `huggingface`). Dense.
    paths: [
      "M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.huggingface,
  },
  cloudflare: {
    // Cloudflare (simple-icons `cloudflare`).
    paths: [
      "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.cloudflare,
  },
  vercel: {
    // Vercel's triangle (simple-icons `vercel`). Monochrome everywhere, so the neutral.
    paths: ["m12 1.608 12 20.784H0Z"],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.monochrome,
  },
  xiaomi: {
    // Xiaomi (simple-icons `xiaomi`).
    paths: [
      "M12 0C8.016 0 4.756.255 2.493 2.516.23 4.776 0 8.033 0 12.012c0 3.98.23 7.235 2.494 9.497C4.757 23.77 8.017 24 12 24c3.983 0 7.243-.23 9.506-2.491C23.77 19.247 24 15.99 24 12.012c0-3.984-.233-7.243-2.502-9.504C19.234.252 15.978 0 12 0zM4.906 7.405h5.624c1.47 0 3.007.068 3.764.827.746.746.827 2.233.83 3.676v4.54a.15.15 0 0 1-.152.147h-1.947a.15.15 0 0 1-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15 0 0 0-.151.147v6.98a.15.15 0 0 1-.152.148H4.906a.15.15 0 0 1-.15-.148V7.554a.15.15 0 0 1 .15-.149zm12.131 0h1.949a.15.15 0 0 1 .15.15v8.892a.15.15 0 0 1-.15.148h-1.949a.15.15 0 0 1-.151-.148V7.554a.15.15 0 0 1 .151-.149zM8.92 10.948h2.046c.083 0 .15.066.15.147v5.352a.15.15 0 0 1-.15.148H8.92a.15.15 0 0 1-.152-.148v-5.352a.15.15 0 0 1 .152-.147Z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.xiaomi,
  },
  openrouter: {
    // OpenRouter's routed arrow (simple-icons `openrouter`).
    paths: [
      "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
    ],
    viewBox: "0 0 24 24",
    tint: MODEL_MARK_TINTS.openrouter,
  },
};

// First-party services and regional twins wear the parent's mark.
Object.assign(PROVIDER_MARK, {
  "google-vertex": PROVIDER_MARK.google,
  "cloudflare-ai-gateway": PROVIDER_MARK.cloudflare,
  "cloudflare-workers-ai": PROVIDER_MARK.cloudflare,
  "vercel-ai-gateway": PROVIDER_MARK.vercel,
  mistral: FAMILY_MARK.mistral,
  deepseek: FAMILY_MARK.deepseek,
  "qwen-token-plan": FAMILY_MARK.qwen,
  "qwen-token-plan-cn": FAMILY_MARK.qwen,
  "qwen-token-plan-individual": FAMILY_MARK.qwen,
  "xiaomi-token-plan-ams": PROVIDER_MARK.xiaomi,
  "xiaomi-token-plan-cn": PROVIDER_MARK.xiaomi,
  "xiaomi-token-plan-sgp": PROVIDER_MARK.xiaomi,
} satisfies Record<string, Mark>);

/**
 * The family a model belongs to, read off its id and label.
 *
 * Prefix rules, not a lookup: the catalog is ~1,300 rows across 39 providers
 * and changes under us. `gpt`, the `o`-series and `codex` are all OpenAI;
 * `claude` is Claude; `gemini` is Gemini; Mistral ships under six names.
 * Anything else has no family here and wears the lettermark.
 */
export function modelFamily(model: Pick<ModelAccessModel, "modelId" | "label">): Family | null {
  const id = `${model.modelId} ${model.label}`.toLowerCase();
  if (/\bclaude\b/.test(id)) return "claude";
  if (/\bgemini\b/.test(id)) return "gemini";
  if (/\bgpt[-\s]?\d|\bgpt\b|\bcodex\b|\bo[1-9](?:-|\b)/.test(id)) return "openai";
  if (/\bdeepseek\b/.test(id)) return "deepseek";
  if (/\b(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)\b/.test(id))
    return "mistral";
  if (/\bllama\b/.test(id)) return "llama";
  if (/\bqwen/.test(id)) return "qwen";
  return null;
}

function markFor(
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">,
  by: MarkBy,
): Mark | null {
  const family = modelFamily(model);
  const familyMark = family === null ? null : FAMILY_MARK[family];
  const providerMark = PROVIDER_MARK[model.providerId] ?? null;
  return by === "family" ? (familyMark ?? providerMark) : (providerMark ?? familyMark);
}

/**
 * The mark alone, `aria-hidden`: it is always beside the label it stands for.
 *
 * Fixed at `size-3.5` — one notch above the harness marks' `size-3`, because
 * this one leads a row of `text-sm` (14px) and a glyph smaller than the x-height
 * beside it reads as a bullet. The lettermark fallback is the same box so the
 * column's left axis holds whichever row has a real mark and whichever does not.
 */
export function ModelMark({
  model,
  providerLabel,
  by = DEFAULT_MARK_BY,
  className,
}: {
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">;
  providerLabel: string;
  by?: MarkBy;
  className?: string;
}) {
  const mark = markFor(model, by);
  if (mark === null) {
    const initial = (by === "provider" ? providerLabel : model.label)
      .trim()
      .charAt(0)
      .toUpperCase();
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-muted-foreground/30 text-label leading-none font-semibold text-muted-foreground",
          className,
        )}
      >
        {initial}
      </span>
    );
  }
  return (
    <svg
      aria-hidden
      viewBox={mark.viewBox}
      fill={mark.tint}
      className={cn("size-3.5 shrink-0", className)}
    >
      {mark.paths.map((path) => (
        <path key={path.slice(0, 24)} d={path} />
      ))}
    </svg>
  );
}

/**
 * The composer's rule (`modelPillLabel`), applied to a list: the provider is
 * said only where the name alone would not say which model this is.
 */
export function needsProvider(
  models: readonly Pick<ModelAccessModel, "providerId" | "modelId" | "label">[],
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">,
): boolean {
  return models.some(
    (candidate) =>
      candidate.label === model.label &&
      (candidate.providerId !== model.providerId || candidate.modelId !== model.modelId),
  );
}

const NO_PROVIDERS: readonly ModelAccessProvider[] = [];

export function providerLabelOf(
  providers: readonly ModelAccessProvider[],
  providerId: string,
): string {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

/**
 * Mark + name, with the provider as a muted trailing term only when needed.
 *
 * The name and its trailing terms are ONE text run, not flex siblings: the
 * spacing around "·" is then the font's own, and it reads the same in a
 * trigger, a list row and a caption. Only the mark is a flex sibling, because
 * it needs a gap that is not a space.
 *
 * `tabular-nums` on the name: "4.5" under "4.6" under "5.3" should sit in one
 * column when the rows are read down, and proportional figures will not.
 *
 * `in-data-[slot=select-item]:hidden` on the provider term: inside a Select's
 * list the group heading already says the provider, so the term would be said
 * twice on one row. The same element is what Radix copies into the closed
 * trigger, where there is no heading — so it stays in the markup and hides
 * itself only where it is redundant.
 */
export function ModelName({
  model,
  models,
  providers = NO_PROVIDERS,
  providerLabel: providerLabelProp,
  by = DEFAULT_MARK_BY,
  /** Say the provider regardless — the Catalog table has a column for it; a pill does not. */
  alwaysProvider = false,
  /** A last term after the provider, for a caption: the reasoning level. */
  trailing,
  muted = false,
  className,
}: {
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">;
  models: readonly Pick<ModelAccessModel, "providerId" | "modelId" | "label">[];
  /** The catalog's providers, for the label; or pass `providerLabel` directly. */
  providers?: readonly ModelAccessProvider[];
  providerLabel?: string;
  by?: MarkBy;
  alwaysProvider?: boolean;
  trailing?: string;
  muted?: boolean;
  className?: string;
}) {
  const providerLabel = providerLabelProp ?? providerLabelOf(providers, model.providerId);
  const sayProvider = alwaysProvider || needsProvider(models, model);
  // The whole run, kept as the element's `title` for the pointer (VC-288).
  const full = [model.label, sayProvider ? providerLabel : null, trailing ?? null]
    .filter((term) => term !== null)
    .join(" · ");
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <ModelMark model={model} providerLabel={providerLabel} by={by} />
      {/* IT WRAPS RATHER THAN TRUNCATES (VC-288 review). A `title` was the whole
          of the way out of a clipped name here, and a `title` is the pointer's
          alone — on rows a keyboard walks, `Claude Son…` was simply where the
          fact ended. Every surface drawing this is a row inside a Select or a
          cmdk list, and both are composite widgets: a focus stop of the kind
          the venue chips grew (`ui/value-reveal.tsx`) would be a nested
          interactive control inside a `role="option"`, which breaks the
          keyboard model of the list to fix the readability of one row in it.
          A second line costs the list nothing and hides nothing.

          THE ONE PLACE IT STILL CLIPS is the closed Select trigger, because
          Radix draws the selected ITEM's own children inside a fixed-height
          control — and that is the one place a reveal already exists: the
          trigger is focusable and one press opens the list where this same
          element wraps. */}
      <span
        title={full}
        className={cn(
          "min-w-0 tabular-nums break-words in-data-[slot=select-trigger]:truncate",
          muted && "text-muted-foreground",
        )}
      >
        {model.label}
        {sayProvider ? (
          <span className="text-muted-foreground in-data-[slot=select-item]:hidden">
            {" "}
            · {providerLabel}
          </span>
        ) : null}
        {trailing !== undefined ? (
          <span className="text-muted-foreground"> · {trailing}</span>
        ) : null}
      </span>
    </span>
  );
}
