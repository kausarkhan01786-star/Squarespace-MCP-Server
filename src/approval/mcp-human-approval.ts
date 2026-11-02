import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MutationApprovalError,
  type HumanApprovalPrompt,
  type MutationProposal,
} from "./mutation-approval.js";

export class McpHumanApprovalPrompt implements HumanApprovalPrompt {
  constructor(
    private readonly server: Pick<
      McpServer["server"],
      "getClientCapabilities" | "elicitInput"
    >,
  ) {}

  async requestApproval(proposal: MutationProposal): Promise<boolean> {
    const capabilities = this.server.getClientCapabilities();
    if (!capabilities?.elicitation?.form) {
      throw new MutationApprovalError(
        "unavailable",
        "The connected MCP host does not advertise form elicitation; CMS mutations are disabled.",
      );
    }

    const result = await this.server.elicitInput({
      mode: "form",
      message: formatProposalForHuman(proposal),
      requestedSchema: {
        type: "object",
        properties: {
          approve: {
            type: "boolean",
            title: "Approve this exact mutation",
            description: "Only approve if the proposal above matches the change you want.",
            default: false,
          },
        },
        required: ["approve"],
      },
    });
    return result.action === "accept" &&
      result.content !== undefined &&
      "approve" in result.content &&
      result.content.approve === true;
  }
}

export function formatProposalForHuman(proposal: MutationProposal): string {
  const publishNotice = proposal.permissionScopes.includes("content.publish")
    ? "This proposal explicitly requests Publish. Accepting it authorizes only the listed Publish operation."
    : "Squarespace Save is not verified as draft-only and may make the requested change live. The proposal does not include or authorize a Publish action.";
  return [
    "A Squarespace CMS mutation is requesting explicit human approval.",
    `Review the complete immutable proposal. ${publishNotice}`,
    JSON.stringify({
      provider: proposal.provider,
      websiteId: proposal.websiteId,
      pageId: proposal.pageId ?? null,
      action: proposal.action,
      targetResource: proposal.targetResource,
      permissionScopes: proposal.permissionScopes,
      changes: proposal.payload,
      payloadHash: proposal.payloadHash,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
    }, null, 2),
    "Declining, canceling, or leaving the approval field unchecked blocks the mutation.",
  ].join("\n\n");
}
