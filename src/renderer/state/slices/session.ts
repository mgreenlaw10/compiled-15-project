/**
 * Who is editing.
 *
 * Cartograph is single-writer today, so this slice holds one local actor and an
 * empty participant list. It exists as its own slice because the actor id is
 * stamped onto every operation: when a second writer arrives, this is where it
 * comes from, and `features/presence/` is what renders it.
 */

import { LOCAL_ACTOR } from '../../../shared/collab'
import type { SessionSlice, Slice } from '../types'

export const createSessionSlice: Slice<SessionSlice> = (set) => ({
  actor: LOCAL_ACTOR,
  participants: [],

  setParticipants(participants) {
    set({ participants })
  }
})
