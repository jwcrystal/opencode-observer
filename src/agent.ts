const OBSERVER_PROMPT = `You are Observer — a visual analysis specialist.

**Role**: Interpret images, screenshots, PDFs, and diagrams. Extract structured observations for the calling agent to act on.

**Behavior**:
- Read the file(s) specified in the prompt
- Analyze visual content — layouts, UI elements, text, relationships, flows
- For screenshots with text/code/errors: extract the **exact text** via OCR — never paraphrase error messages or code
- For multiple files: analyze each, then compare or relate as requested
- Return ONLY the extracted information relevant to the goal
- If the image is unclear, blurry, or partially visible: state what you CAN see and explicitly note what is uncertain — never guess or fabricate details

**Constraints**:
- READ-ONLY: Analyze and report, don't modify files
- Save context tokens — the calling agent never processes the raw file
- Match the language of the request
- If info not found, state clearly what's missing

**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Prefer dedicated file tools for codebase inspection: glob/grep for discovery and read for file content.
- Bash is allowed for non-mutating diagnostics and shell-native inspection when it is the clearest tool, but not for modifying files.`;

export const OBSERVER_SYSTEM_HINT =
  '@observer is available for visual analysis of images, screenshots, PDFs, and diagrams. When images are present and your model may not support them, delegate to @observer with the full file path.';

export const DEFAULT_OBSERVER_MODEL = 'openai/gpt-4o';

export const OBSERVER_TEMPERATURE = 0.1;

/** Agent id used in both V1 config and V2 agent transforms. */
export const OBSERVER_AGENT_ID = 'observer';

export const OBSERVER_DESCRIPTION =
  'Visual analysis. Use for interpreting images, screenshots, PDFs, and diagrams — extracts structured observations without loading raw files into main context. Requires a vision-capable model.';

export function createObserverAgentConfig(model: string) {
  return {
    model,
    temperature: OBSERVER_TEMPERATURE,
    prompt: OBSERVER_PROMPT,
    description: OBSERVER_DESCRIPTION,
    mode: 'subagent' as const,
  };
}

/** The observer agent system prompt (V1 `prompt` field / V2 `system` field). */
export const OBSERVER_PROMPT_TEXT = OBSERVER_PROMPT;

/**
 * Parse a `provider/model` reference (with optional `#variant` suffix) into
 * the `{ providerID, id, variant? }` object shape used by V2 `Agent.Info`.
 */
export function parseModelRef(ref: string): {
  providerID: string;
  id: string;
  variant?: string;
} {
  const slash = ref.indexOf('/');
  const providerID = slash === -1 ? 'openai' : ref.slice(0, slash);
  let model = slash === -1 ? ref : ref.slice(slash + 1);
  let variant: string | undefined;
  const hash = model.indexOf('#');
  if (hash !== -1) {
    variant = model.slice(hash + 1);
    model = model.slice(0, hash);
  }
  return { providerID, id: model, variant };
}
