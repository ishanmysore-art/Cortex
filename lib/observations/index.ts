/**
 * The observation spine.
 *
 * The rest of the application records and reads history through this module
 * and never touches the `observations` table directly, so the storage shape can
 * change without a sweep through call sites.
 */
export {
  OBSERVATION_ACTORS,
  OBSERVATION_CATEGORIES,
  OBSERVATION_EVENTS,
  OBSERVATION_EVENT_TYPES,
  OBSERVATION_SOURCE_TYPES,
  OBSERVATION_CONTEXT_MAX_BYTES,
  OBSERVATION_PAYLOAD_MAX_BYTES,
  isObservationEventType,
  type Observation,
  type ObservationActor,
  type ObservationCategory,
  type ObservationContext,
  type ObservationEventType,
  type ObservationInput,
  type ObservationPayloads,
  type ObservationSourceType,
} from "@/lib/observations/types";

export {
  buildObservationRow,
  recordObservation,
  recordObservations,
  type ObservationRow,
  type RecordResult,
} from "@/lib/observations/recorder";

export {
  getObservation,
  listObservations,
  toObservation,
  type ListObservationsOptions,
} from "@/lib/observations/queries";
