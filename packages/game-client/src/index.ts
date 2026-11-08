export { ConnectRefusedError, GamePeer, spectatorAccepted, type GamePeerOptions, type WatchResult } from './lib/peer.js';
export { parseServerMessage, type EntityObservation, type ParseResult, type ParsedSnapshot } from './lib/snapshot.js';
export { huffmanCompress, huffmanDecompress } from './lib/huffman.js';
export {
  buildClientDatagram,
  buildConnectPacket,
  buildDisconnectDatagram,
  buildGetchallengePacket,
  buildGetstatusPacket,
  buildSpectatorUserinfo,
  connectAllowed,
  decodeClientDatagram,
  parseStatusBody,
  SPECTATOR_NAME,
  type ClientDatagram,
  type StatusInfo,
} from './lib/wire.js';
