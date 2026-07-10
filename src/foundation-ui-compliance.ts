import { readFileSync } from "node:fs";
import type { SavedWorkflowDefinition } from "./workflow-saved.js";

export const FOUNDATION_UI_COMPLIANCE_NAME = "foundation_ui_compliance";

const templateUrl = new URL("../docs/workflows/templates/foundation_ui_compliance.workflow.mjs", import.meta.url);

/** Load the canonical package template as an overridable bundled saved workflow. */
export function createBundledFoundationUiComplianceWorkflow(): SavedWorkflowDefinition {
  return {
    name: FOUNDATION_UI_COMPLIANCE_NAME,
    description:
      "Foundation UI compliance: pass one JSON args object; see docs/workflows/foundation-ui-compliance.md. Delivery defaults to false.",
    script: readFileSync(templateUrl, "utf8"),
  };
}
