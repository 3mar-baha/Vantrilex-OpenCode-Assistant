// The locked 3-agent roster. Shared by the companion HUD and the settings
// window so both surfaces describe the same chain.
//
// The coordinator role is served by the Inkling model
// (thinkingmachines/inkling:free — see COORDINATOR_MODEL), so Inkling appears
// twice with two different roles. That is the truth, not a typo: one model,
// two jobs. "Nemotron" survives only as the coordinator role name in the
// mission-handoff envelope contract, never as a model slug.
export const AGENT_CHAIN = [
  { id: 'dots3', name: 'Dots3', role: 'الاستقبال الحواري' },
  { id: 'inkling-coordinator', name: 'Inkling', role: 'المنسق الرئيسي' },
  { id: 'inkling', name: 'Inkling', role: 'المنفذ داخل الجلسة' },
] as const;