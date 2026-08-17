/**
 * Proactive notices, and the response loop that makes them evaluable.
 *
 * The loop was built before the detectors on purpose: a dismissal is the only
 * honest signal that Cortex was wrong to raise something, and an interaction
 * that was never recorded cannot be reconstructed later.
 */
export {
  NOTICE_KINDS,
  NOTICE_RESPONSES,
  NOTICE_THRESHOLDS,
  isNoticeKind,
  type Notice,
  type NoticeDetectionSummary,
  type NoticeKind,
  type NoticePayloads,
  type NoticeResponse,
} from "@/lib/notices/types";

export {
  listNotices,
  markNoticesSurfaced,
  refreshNotices,
  toNotice,
} from "@/lib/notices/queries";
