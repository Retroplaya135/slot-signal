import {
  createClientErrorEnvelope,
  createEnvelope,
  parseExtensionMessage,
  type CreateEnvelopeInput,
  type ExtensionMessage,
  type ExtensionMessageType
} from "@slot-signal/contracts";

export type RuntimeMessenger = {
  sendMessage(message: ExtensionMessage): Promise<unknown>;
};

export async function sendRuntimeMessage<Type extends ExtensionMessageType>(
  messenger: RuntimeMessenger,
  input: CreateEnvelopeInput<Type>
): Promise<ExtensionMessage> {
  const message = createEnvelope(input);

  try {
    const response = await messenger.sendMessage(message);
    const parsed = parseExtensionMessage(response);
    if (parsed.ok) return parsed.message;

    return createClientErrorEnvelope({
      actor: input.actor,
      code: "malformed_message",
      idempotencyKey: message.idempotencyKey,
      issues: parsed.error.payload.issues,
      message: "Runtime returned an invalid message envelope.",
      traceId: message.traceId
    });
  } catch {
    return createClientErrorEnvelope({
      actor: input.actor,
      code: "message_send_failed",
      idempotencyKey: message.idempotencyKey,
      message: "Runtime message could not be delivered.",
      traceId: message.traceId
    });
  }
}

export {
  createClientErrorEnvelope,
  createEnvelope,
  isExtensionMessage,
  parseExtensionMessage
} from "@slot-signal/contracts";
export type {
  ClientErrorPayload,
  ExtensionActor,
  ExtensionMessage,
  ExtensionMessageByType,
  ExtensionMessageType,
  VisaDebugExportPayload,
  VisaQueueStatePayload
} from "@slot-signal/contracts";
