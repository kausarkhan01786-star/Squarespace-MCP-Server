import type { MutationProposalInput } from "./mutation-approval.js";

export function textSectionMutationProposal(input: {
  websiteId: string;
  pageId: string;
  text: string;
  backgroundColor?: string | undefined;
  textColor?: string | undefined;
}): MutationProposalInput {
  const targetResource = `page:${input.pageId}:bottom-section`;
  return {
    provider: "squarespace",
    websiteId: input.websiteId,
    pageId: input.pageId,
    action: "content.add_text_section",
    targetResource,
    payload: textSectionMutationPayload(input.text, input.backgroundColor, input.textColor),
    permissionScopes: ["content.section.create", "content.save"],
  };
}

export function textSectionMutationPayload(
  text: string,
  backgroundColor: string | undefined = "#FFFFFF",
  textColor: string | undefined = "#000000",
): Record<string, unknown> {
  return {
    sectionPosition: "bottom",
    block: { type: "Text", text },
    sectionBackground: backgroundColor ?? "#FFFFFF",
    textColor: textColor ?? "#000000",
    save: true,
    publish: false,
  };
}
