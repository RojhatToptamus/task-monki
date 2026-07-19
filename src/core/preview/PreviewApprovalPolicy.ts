import { randomUUID } from 'node:crypto';
import type {
  ApprovePreviewPlanRequest,
  PreviewApprovalRecord,
  PreviewPlanRecord
} from '../../shared/contracts';
import { FileTaskStore } from '../storage/FileTaskStore';

export class PreviewApprovalPolicy {
  constructor(private readonly store: FileTaskStore) {}

  async approve(input: ApprovePreviewPlanRequest): Promise<PreviewApprovalRecord> {
    const plan = await this.store.getPreviewPlan(input.planId);
    if (!plan || plan.taskId !== input.taskId) {
      throw new Error('Preview plan was not found for this task.');
    }
    if (plan.executionDigest !== input.executionDigest) {
      throw new Error('Preview plan digest changed; resolve and review the current plan again.');
    }
    const approval: PreviewApprovalRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      planId: plan.id,
      executionDigest: plan.executionDigest,
      scope: 'TASK',
      approvedAt: new Date().toISOString()
    };
    return this.store.savePreviewApproval(approval);
  }

  async requireMatching(plan: PreviewPlanRecord): Promise<PreviewApprovalRecord> {
    const approval = await this.store.getMatchingPreviewApproval(
      plan.taskId,
      plan.executionDigest
    );
    if (!approval) {
      throw new Error('Preview plan approval is required before any command can execute.');
    }
    return approval;
  }
}
