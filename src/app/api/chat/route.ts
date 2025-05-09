import {
  appendResponseMessages,
  createDataStreamResponse,
  smoothStream,
  streamText,
  Tool,
  type UIMessage,
} from "ai";

import {
  generateTitleFromUserMessageAction,
  rememberProjectInstructionsAction,
} from "@/app/api/chat/actions";
import { customModelProvider, isToolCallUnsupported } from "lib/ai/models";

import { getMockUserSession } from "lib/mock";
import { mcpClientsManager } from "../mcp/mcp-manager";

import { chatService } from "lib/db/chat-service";
import logger from "logger";
import { SYSTEM_TIME_PROMPT } from "lib/ai/prompts";
import { ChatMessageAnnotation } from "app-types/chat";
import { generateUUID } from "lib/utils";

const { insertMessage, insertThread, selectThread } = chatService;

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const {
      id,
      messages,
      model: modelName,
      action,
      projectId,
      activeTool,
    } = json as {
      id?: string;
      messages: Array<UIMessage>;
      model: string;
      projectId?: string;
      action?: "update-assistant" | "";
      activeTool?: boolean;
    };

    let thread = id ? await selectThread(id) : null;

    const userId = getMockUserSession().id;

    const message = messages
      .filter((message) => message.role === "user")
      .at(-1);

    if (!message) {
      return new Response("No user message found", { status: 400 });
    }

    if (!thread) {
      const title = await generateTitleFromUserMessageAction({
        message,
        model: customModelProvider.getModel(modelName),
      });

      thread = await insertThread({
        title,
        id: id ?? generateUUID(),
        userId,
        projectId: projectId ?? null,
      });
    }

    const projectInstructions = projectId
      ? await rememberProjectInstructionsAction(projectId)
      : null;

    const annotations: ChatMessageAnnotation[] =
      (message.annotations as ChatMessageAnnotation[]) ?? [];

    const requiredTools = annotations
      .flatMap((annotation) => annotation.requiredTools)
      .filter(Boolean) as string[];

    const mcpTools = mcpClientsManager.tools();

    const model = customModelProvider.getModel(modelName);

    const toolChoice = !activeTool ? "none" : "auto";

    const systemPrompt = [SYSTEM_TIME_PROMPT, projectInstructions?.systemPrompt]
      .filter(Boolean)
      .join("\n\n---\n\n");

    const tools =
      isToolCallUnsupported(model) || !activeTool
        ? undefined
        : requiredTools.length
          ? filterToolsByMentions(requiredTools, mcpTools)
          : mcpTools;

    return createDataStreamResponse({
      execute: (dataStream) => {
        const result = streamText({
          model,
          system: systemPrompt,
          messages,
          maxSteps: 10,
          experimental_transform: smoothStream({ chunking: "word" }),
          tools,
          toolChoice,
          onFinish: async ({ response, usage }) => {
            const [, assistantMessage] = appendResponseMessages({
              messages: [message],
              responseMessages: response.messages,
            });
            if (action !== "update-assistant") {
              await insertMessage({
                threadId: thread.id,
                model: null,
                role: "user",
                parts: message.parts,
                attachments: [],
                id: message.id,
                annotations: appendAnnotations(message.annotations, {
                  usageTokens: usage.promptTokens,
                }),
              });
            }

            await insertMessage({
              model: modelName,
              threadId: thread.id,
              role: "assistant",
              id: assistantMessage.id,
              parts: assistantMessage.parts as UIMessage["parts"],
              attachments: [],
              annotations: appendAnnotations(assistantMessage.annotations, {
                usageTokens: usage.completionTokens,
              }),
            });
          },
        });
        result.consumeStream();
        result.mergeIntoDataStream(dataStream, {
          sendReasoning: true,
        });
      },
      onError: (error: any) => {
        logger.error(error);
        return JSON.stringify(error) || "Oops, an error occured!";
      },
    });
  } catch (error: any) {
    logger.error(error);
    return new Response(error.message || "Oops, an error occured!", {
      status: 500,
    });
  }
}

function filterToolsByMentions(
  mentions: string[],
  tools: Record<string, Tool>,
) {
  return Object.fromEntries(
    Object.keys(tools)
      .filter((tool) => mentions.some((mention) => tool.startsWith(mention)))
      .map((tool) => [tool, tools[tool]]),
  );
}

function appendAnnotations(
  annotations: any[] = [],
  annotationsToAppend: ChatMessageAnnotation[] | ChatMessageAnnotation,
): ChatMessageAnnotation[] {
  const newAnnotations = Array.isArray(annotationsToAppend)
    ? annotationsToAppend
    : [annotationsToAppend];
  return [...annotations, ...newAnnotations];
}
