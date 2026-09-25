// The locked 3-agent roster. Shared by the companion HUD and the settings
// window so both surfaces describe the same chain.
export const AGENT_CHAIN = [
  { id: 'dots3', name: 'Dots3', role: 'الاستقبال الحواري' },
  { id: 'nemotron', name: 'Nemotron', role: 'المنسق الرئيسي' },
  { id: 'inkling', name: 'Inkling', role: 'المنفذ داخل الجلسة' },
] as const;