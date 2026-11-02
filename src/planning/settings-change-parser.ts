import type { ParsedSettingsChangeIntent } from "./settings-change-types.js";

const timezonePattern =
  /^(?:change|set|update)\s+(?:my\s+)?(?:(?:website|site)\s+)?(?:time\s*zone|timezone)\s+(?:to|as)\s+(.+?)\.?$/i;
const togglePattern =
  /^(enable|disable)\s+(?:the\s+)?(.+?)\.?$/i;
const actionPattern = /^(?:change|set|update|enable|disable)\b/i;

export function parseSettingsChangeInstruction(
  instruction: string,
): ParsedSettingsChangeIntent[] {
  const clauses = instruction
    .trim()
    .split(/\s+and\s+(?=(?:change|set|update|enable|disable)\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);

  if (clauses.length === 0) return [];

  return clauses.map((clause) => {
    const timezone = timezonePattern.exec(clause);
    if (timezone?.[1]) {
      return {
        categoryId: "website",
        fieldId: null,
        fieldLabel: "Time Zone",
        proposedValue: timezone[1].trim(),
        valueType: "string",
        operation: "update",
        confidence: 0.95,
        status: "RESOLVED",
        warnings: [
          "The requested timezone is retained verbatim; this parser does not map city names to canonical timezone identifiers.",
        ],
      };
    }

    const toggle = togglePattern.exec(clause);
    if (toggle?.[1] && toggle[2]) {
      const fieldLabel = toggle[2].trim();
      const value = toggle[1].toLowerCase() === "enable";
      const knownCategory = fieldLabel.toLowerCase() === "site availability"
        ? "website"
        : null;
      return {
        categoryId: knownCategory,
        fieldId: null,
        fieldLabel,
        proposedValue: value,
        valueType: "boolean",
        operation: "update",
        confidence: knownCategory ? 0.75 : 0.45,
        status: knownCategory ? "RESOLVED" : "NEEDS_CLARIFICATION",
        ...(!knownCategory
          ? { clarification: "The settings category cannot be determined from the instruction alone." }
          : {}),
        warnings: [
          "The target is not accepted unless an exact matching field is returned by read-only inspection.",
        ],
      };
    }

    return {
      categoryId: null,
      fieldId: null,
      fieldLabel: clause,
      proposedValue: null,
      valueType: "unknown",
      operation: "update",
      confidence: actionPattern.test(clause) ? 0.2 : 0,
      status: "NEEDS_CLARIFICATION",
      clarification: "Specify one identifiable settings field and its requested value.",
      warnings: ["No setting or proposed value was inferred."],
    };
  });
}
