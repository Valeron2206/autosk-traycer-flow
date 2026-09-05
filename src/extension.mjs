/** autoskd v2 native extension factory. No scheduler, task database, or daemon is created. */
import { demand } from './runtime/contracts.mjs';
import { doctor } from './runtime/doctor.mjs';

export default function autoskFlowExtension(autosk) {
  demand(autosk && typeof autosk.registerWorkflow === 'function', 'sdk_incompatible',
    'autosk-flow requires the autoskd v2 extension API');
  autosk.registerWorkflow({
    name: 'autosk-flow-diagnostics',
    description: 'Read-only runtime foundation diagnostics; not the Planned/Quick execution workflow.',
    firstStep: 'inspect',
    steps: {
      inspect: {
        async onRun(ctx) {
          demand(ctx.mode === 'task', 'task_context_required', 'Diagnostics workflow needs a task context');
          const report = doctor(ctx.projectRoot, ctx);
          ctx.log.custom('autosk-flow:doctor', report);
          await ctx.transit({ status: report.production_ready ? 'done' : 'human' });
        },
      },
    },
    onTransit(_ctx, to) {
      demand((Object.keys(to).length === 1 && to.step === 'inspect')
        || (Object.keys(to).length === 1 && to.status === 'human'),
      'transition_not_allowed', 'Foundation diagnostics cannot mark the project complete');
    },
  });
}
