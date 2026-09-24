export {
  ACK_KIND,
  ERROR_KIND,
  IPC_TOKEN_ENV,
  MISSED_PINGS_LIMIT,
  Opcode,
  PING_INTERVAL_MS,
  RESUME_BUFFER_CAP,
  SERVE_PORT,
  UI_SUBPROTOCOL,
  UI_WS_PATH,
  UI_WS_PORT,
  AckFrameSchema,
  buildAgentFrame,
  buildInventoryFrame,
  decodeFrames,
  encodeTextFrame,
  HelloFrameSchema,
  AgentEntrySchema,
  AgentFrameSchema,
  InventoryFrameSchema,
  maskFrame,
  UiCommandSchema,
  UiEventSchema,
} from './protocol.js';
export type { AgentEntry, AgentFrame, HelloFrame, InventoryFrame, UiCommand, UiEvent, WsFrame } from './protocol.js';
export { UiServer } from './ui-server.js';
export type { UiServerOptions, CommandOutcome } from './ui-server.js';
