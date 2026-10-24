# Rx Agent Product Quality Standard

Rx is both the product and its own developer. Develop it as a world-class,
production-grade open-source application and as the user's primary agent and
interface to the outside world.

User-visible quality is non-negotiable. UX and DX are a release boundary, not
polish. The product must feel unified, restrained, refined, ordered, fast, and
trustworthy from its first interaction. Eliminate cheapness, patchwork,
staticness, and feature-accumulation artifacts.

- Favor a small number of high-value, real user workflows over feature volume.
  Do not add a capability unless it materially improves a clear primary path.
- Build one coherent system: information architecture, terminology, interaction
  patterns, states, errors, shortcuts, typography, spacing, color, and motion
  must agree.
- Use progressive disclosure. Make the safe default reliable, the novice path
  understandable, and expert workflows increasingly fast.
- Make execution observable. Loading, streaming, tool execution, waiting for
  approval, success, cancellation, and failure must have prompt, accurate,
  comprehensible feedback. Never make users guess what Rx is doing.
- Treat DX as product UX: installation, configuration, CLI output, help,
  examples, errors, logs, upgrades, recovery, and automation must be designed
  with the same care as interactive surfaces.
- Treat performance and reliability as user experience: startup, time to first
  useful response, responsiveness, long-running task progress, failure
  recovery, and graceful degradation are primary-path requirements.
- Ship open source with product completeness: reproducible builds, accurate
  documentation, clear contribution paths, explicit licenses, and strong
  security boundaries. Open source is never an excuse for a rough experience.
- Earn repeated use through usefulness, fluency, trust, and user control, never
  through dark patterns, deceptive urgency, manipulative notifications, or
  engineered dependency.
- Verify the full experience, not only code correctness. Review first-run,
  normal, empty, loading, streaming, error, cancellation, recovery, upgrade,
  accessibility, and edge-case paths appropriate to every user-visible change.

Do not mistake premium quality for decorative complexity. Premium quality means
users immediately understand what to do, always understand what is happening,
retain control when something fails, and become faster with continued use.

For every Rx change, assess three layers:

1. Core experience: first run, provider configuration, model selection, task
   execution, tool approval, streamed output, errors, and task recovery form a
   low-friction coherent path.
2. Agent behavior: plans, progress, risks, approval requests, and final reports
   are concise, accurate, structured, and free of performative noise.
3. Engineering gate: user-visible changes require consistency review, real-path
   validation, and applicable project checks. Passing tests alone does not make
   a change ready to ship.
