/**
 * Compatibility exports for the legacy Fugu-named issue-delivery workflow.
 *
 * The canonical implementation lives in issue-delivery.ts. Keep this module for
 * callers that still import generateFuguWorkflow during the naming migration.
 */
export { generateIssueDeliveryWorkflow as generateFuguWorkflow } from "./issue-delivery.js";
