import { createHash } from "node:crypto";
import { z } from "zod";
import { createCalendarEvent, updateCalendarEvent } from "./calendar";
import { ProposedActionRecord, RequestContext } from "./contracts";
import { MemoryStore } from "./memory/store";

export const CalendarActionSchema = z.object({
  title: z.string().min(1),
  startDateTime: z.string().datetime({ offset: true }),
  endDateTime: z.string().datetime({ offset: true }),
  description: z.string().default(""),
  attendeeEmails: z.array(z.string().email()).default([]),
  eventId: z.string().nullable().default(null),
}).strict();

export type CalendarAction = z.infer<typeof CalendarActionSchema>;

export interface CalendarGateway {
  create(payload: CalendarAction): Promise<Record<string, unknown>>;
  update(payload: CalendarAction): Promise<Record<string, unknown>>;
}

export class GoogleCalendarGateway implements CalendarGateway {
  async create(payload: CalendarAction): Promise<Record<string, unknown>> {
    return createCalendarEvent(payload.title, payload.startDateTime, payload.endDateTime,
      payload.description, payload.attendeeEmails);
  }
  async update(payload: CalendarAction): Promise<Record<string, unknown>> {
    if (!payload.eventId) throw new Error("eventId is required for calendar.update");
    return updateCalendarEvent(payload.eventId, payload.title, payload.startDateTime,
      payload.endDateTime, payload.description, payload.attendeeEmails);
  }
}

export class DemoCalendarGateway implements CalendarGateway {
  async create(payload: CalendarAction): Promise<Record<string, unknown>> {
    return {
      id: `demo-${Buffer.from(payload.title).toString("hex").slice(0, 16)}`,
      summary: payload.title,
      htmlLink: "https://calendar.google.com/calendar/u/0/r",
      simulated: true,
    };
  }
  async update(payload: CalendarAction): Promise<Record<string, unknown>> {
    return {
      id: payload.eventId,
      summary: payload.title,
      htmlLink: "https://calendar.google.com/calendar/u/0/r",
      simulated: true,
    };
  }
}

export class ActionExecutor {
  constructor(
    private readonly store: MemoryStore,
    private readonly calendar: CalendarGateway,
  ) {}

  async proposeCalendarEvent(
    context: RequestContext,
    meetingId: string,
    input: CalendarAction,
    correlationId: string,
    memoryId: string | null = null,
  ): Promise<ProposedActionRecord> {
    const payload = CalendarActionSchema.parse(input);
    if (new Date(payload.endDateTime) <= new Date(payload.startDateTime)) throw new Error("INVALID_TIME");
    const actionType = payload.eventId ? "calendar.update" : "calendar.create";
    const idempotencyKey = createHash("sha256")
      .update(`${meetingId}:${actionType}:${JSON.stringify(payload)}`)
      .digest("hex");
    return this.store.proposeAction(context, meetingId, memoryId, actionType, payload, {
      title: payload.title,
      when: `${payload.startDateTime} — ${payload.endDateTime}`,
      attendees: payload.attendeeEmails,
      requiresConfirmation: true,
      correlationId,
    }, idempotencyKey);
  }

  async confirmCalendarEvent(
    context: RequestContext,
    actionId: string,
    editedPayload?: unknown,
  ): Promise<ProposedActionRecord> {
    const current = await this.store.getAction(context, actionId);
    if (!current) throw new Error("ACTION_NOT_FOUND_OR_FORBIDDEN");
    if (current.status === "completed") return current;
    if (!['awaiting_confirmation', 'failed'].includes(current.status)) throw new Error("ACTION_ALREADY_PROCESSING");
    const payload = CalendarActionSchema.parse(editedPayload ?? current.proposal);
    const executing = await this.store.markActionExecuting(context, actionId, context.userId);
    try {
      const result = executing.actionType === "calendar.update"
        ? await this.calendar.update(payload)
        : await this.calendar.create(payload);
      const completed = await this.store.completeAction(context, actionId, result, {
        provider: "google_calendar",
        executedAt: new Date().toISOString(),
        confirmedBy: context.userId,
        result,
      });
      await this.store.enqueueJob({
        workspaceId: context.workspaceId,
        meetingId: completed.meetingId,
        eventType: "action.completed",
        correlationId: String(completed.preview.correlationId ?? actionId),
        idempotencyKey: `curate:action:${actionId}`,
        payload: { userId: context.userId, action: completed },
      });
      return completed;
    } catch (error) {
      await this.store.failAction(context, actionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
