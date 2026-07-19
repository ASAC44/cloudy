"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  ArrowUp,
  Cable,
  Check,
  CheckCircle2,
  CircleAlert,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import {
  commitRuleBuilderSession,
  createRuleBuilderSession,
  getRuleBuilderSession,
  sendRuleBuilderTurn,
  startConnectionOAuth,
} from "@/app/(dashboard)/actions";
import { ProviderLogo } from "@/components/dashboard/connections/provider-logo";
import { humanizeRuleError, toggleValue } from "@/components/dashboard/rule-builder-chat-state";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type {
  ConnectionProvider,
  RuleBuilderReply,
  RuleBuilderSession,
  RuleQuestion,
} from "@/lib/api";

export const RULE_CHAT_SESSION_KEY = "podex:rule-builder:v2";

const noStoreSubscription = () => () => undefined;

export function NewPingChat({
  podName,
  initialOpen = false,
  initialSessionId,
  editingRuleId,
  resumeError = false,
}: {
  podName: string;
  initialOpen?: boolean;
  initialSessionId?: string;
  editingRuleId?: string;
  resumeError?: boolean;
}) {
  const storedSessionId = useSyncExternalStore(
    noStoreSubscription,
    readStoredSession,
    () => "",
  );
  const resumeId = initialSessionId ?? (storedSessionId || undefined);

  return (
    <RuleChatDialog
      key={resumeId ?? editingRuleId ?? "new-rule"}
      podName={podName}
      initialOpen={initialOpen || Boolean(resumeId) || Boolean(editingRuleId)}
      resumeId={resumeId}
      editingRuleId={editingRuleId}
      resumeError={resumeError}
    />
  );
}

export function OAuthChatResume({ connected, failed }: { connected: boolean; failed: boolean }) {
  useEffect(() => {
    if (!connected && !failed) return;
    const sessionId = sessionStorage.getItem(RULE_CHAT_SESSION_KEY);
    if (!sessionId) return;
    window.location.replace(`/home?chat=${encodeURIComponent(sessionId)}&connection=${connected ? "connected" : "error"}`);
  }, [connected, failed]);
  return null;
}

function RuleChatDialog({
  podName,
  initialOpen,
  resumeId,
  editingRuleId,
  resumeError,
}: {
  podName: string;
  initialOpen: boolean;
  resumeId?: string;
  editingRuleId?: string;
  resumeError: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [session, setSession] = useState<RuleBuilderSession | null>(null);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [error, setError] = useState(resumeError ? "The connection was not completed. You can retry or continue editing." : "");
  const [complete, setComplete] = useState(false);
  const [pending, startTransition] = useTransition();
  const loading = useRef(false);

  useEffect(() => {
    if (!open || session || loading.current) return;
    loading.current = true;
    startTransition(async () => {
      const result = resumeId
        ? await getRuleBuilderSession(resumeId)
        : await createRuleBuilderSession(editingRuleId);
      loading.current = false;
      if (!result.session) {
        setError(humanizeRuleError(result.error));
        if (result.error?.includes("expired") || result.error?.includes("not found")) {
          sessionStorage.removeItem(RULE_CHAT_SESSION_KEY);
        }
        return;
      }
      setSession(result.session);
      sessionStorage.setItem(RULE_CHAT_SESSION_KEY, result.session.id);
      if (initialOpen) window.history.replaceState(null, "", "/home");
    });
  }, [editingRuleId, initialOpen, open, resumeId, session]);

  function sendTurn(inputValue?: string, answers?: Array<{ question_id: string; value: string | string[] }>) {
    if (!session || pending) return;
    const message = inputValue?.trim();
    if (!message && !answers?.length) return;
    setError("");
    setInput("");
    startTransition(async () => {
      const result = await sendRuleBuilderTurn({
        sessionId: session.id,
        revision: session.revision,
        message,
        answers,
      });
      if (!result.session) {
        setError(humanizeRuleError(result.error));
        return;
      }
      setSession(result.session);
      setSelected({});
    });
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendTurn(input);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function saveDefinition() {
    if (!session || pending) return;
    setError("");
    startTransition(async () => {
      const result = await commitRuleBuilderSession(session.id, session.revision);
      if (result.session) {
        setSession(result.session);
        setError("The source changed, so I refreshed it for review.");
        return;
      }
      if (!result.committed || !result.rule) {
        setError(humanizeRuleError(result.error));
        return;
      }
      sessionStorage.removeItem(RULE_CHAT_SESSION_KEY);
      setComplete(true);
    });
  }

  function connectProvider(provider: ConnectionProvider | "other") {
    if (!session) return;
    sessionStorage.setItem(RULE_CHAT_SESSION_KEY, session.id);
    if (provider !== "github" && provider !== "gmail") {
      window.location.assign(`/connections?resume=${encodeURIComponent(session.id)}`);
      return;
    }
    startTransition(async () => {
      const result = await startConnectionOAuth(provider, providerName(provider));
      if (result.authorization_url) window.location.assign(result.authorization_url);
      else setError(result.error ?? `${providerName(provider)} could not be connected.`);
    });
  }

  function newRule() {
    sessionStorage.removeItem(RULE_CHAT_SESSION_KEY);
    window.location.assign("/home?chat=new");
  }

  const reply = session?.reply;
  const transcript = session?.messages ?? [];
  const leadingMessages = transcript.at(-1)?.role === "assistant" ? transcript.slice(0, -1) : transcript;
  const announcement = pending
    ? session ? "Podex is thinking." : "Discovering connected capabilities."
    : complete
      ? `Definition saved. It is not running yet and targets ${podName}.`
      : error || reply?.message || "Create a Ping definition.";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" />}>
        Add
        <Plus aria-hidden="true" />
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="inset-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-background/90 p-0 ring-0 backdrop-blur-md sm:max-w-none"
      >
        <DialogTitle className="sr-only">Create a Ping definition</DialogTitle>
        <DialogDescription className="sr-only">
          Describe what Podex should watch, answer clarifying questions, and save a non-running definition.
        </DialogDescription>
        <p className="sr-only" aria-live="polite">{announcement}</p>

        <div className="flex h-full min-h-0 flex-col">
          <header className="shrink-0 border-b border-border/70 bg-background/55 px-5 py-4 sm:px-8">
            <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
                  <Sparkles className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{session?.editing_rule_id ? "Edit Ping definition" : "New Ping definition"}</p>
                  <p className="text-caption text-muted-foreground">Saved configuration · execution is not enabled</p>
                </div>
              </div>
              <DialogClose render={<Button variant="ghost" size="icon" aria-label="Close chat" />}>
                <X aria-hidden="true" />
              </DialogClose>
            </div>
          </header>

          <MessageScrollerProvider>
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="mx-auto w-full max-w-4xl px-5 py-8 pb-40 sm:px-8 sm:py-12 sm:pb-44">
                  {leadingMessages.map((message, index) => (
                    <MessageScrollerItem key={`${message.role}-${index}`}>
                      {message.role === "user" ? <UserMessage>{message.content}</UserMessage> : <AssistantMessage>{message.content}</AssistantMessage>}
                    </MessageScrollerItem>
                  ))}

                  {!session ? (
                    <MessageScrollerItem scrollAnchor>
                      <AssistantMessage>
                        {pending || !error ? (
                          <Attachment state="processing" className="max-w-sm bg-background/60 motion-reduce:[&_.shimmer]:animate-none">
                            <AttachmentMedia><Cable className="size-4" /></AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle>Discovering connected capabilities</AttachmentTitle>
                              <AttachmentDescription>Reading safe tool descriptions and input schemas</AttachmentDescription>
                            </AttachmentContent>
                          </Attachment>
                        ) : (
                          <SetupError error={error} onRetry={newRule} />
                        )}
                      </AssistantMessage>
                    </MessageScrollerItem>
                  ) : complete ? (
                    <MessageScrollerItem scrollAnchor>
                      <AssistantMessage>
                        <div className="flex items-start gap-3 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                          <div>
                            <p className="font-medium">Definition saved</p>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                              It is stored for {podName}, but it is not running yet. Polling and Ping delivery will come with the executor.
                            </p>
                            <div className="mt-5 flex flex-wrap gap-2">
                              <Button size="sm" variant="outline" onClick={newRule}><RotateCcw />New definition</Button>
                              <Button size="sm" nativeButton={false} render={<Link href="/configure" />}>View definitions</Button>
                            </div>
                          </div>
                        </div>
                      </AssistantMessage>
                    </MessageScrollerItem>
                  ) : reply ? (
                    <MessageScrollerItem scrollAnchor>
                      <AssistantMessage>
                        <p className="text-base leading-7">{reply.message}</p>
                        <CapabilityEvidence session={session} />
                        {reply.questions.map((question) => (
                          <QuestionControl
                            key={question.id}
                            question={question}
                            selected={selected[question.id] ?? []}
                            disabled={pending}
                            onToggle={(value) => setSelected((current) => ({
                              ...current,
                              [question.id]: toggleValue(current[question.id] ?? [], value),
                            }))}
                            onSend={(value) => sendTurn(undefined, [{ question_id: question.id, value }])}
                          />
                        ))}
                        {reply.connection_requirement ? (
                          <ConnectionRequirement
                            requirement={reply.connection_requirement}
                            pending={pending}
                            error={error}
                            onConnect={() => connectProvider(reply.connection_requirement!.provider)}
                          />
                        ) : null}
                        {reply.phase === "review" && reply.draft.ready ? (
                          <RuleReview reply={reply} podName={podName} pending={pending} onSave={saveDefinition} />
                        ) : null}
                        {error && !reply.connection_requirement ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
                        {pending ? (
                          <Attachment state="processing" className="mt-5 max-w-sm bg-background/60 motion-reduce:[&_.shimmer]:animate-none">
                            <AttachmentMedia><Spinner className="motion-reduce:animate-none" /></AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle>Working through your request</AttachmentTitle>
                              <AttachmentDescription>Using your selected model and connected capabilities</AttachmentDescription>
                            </AttachmentContent>
                          </Attachment>
                        ) : null}
                      </AssistantMessage>
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>

          {!complete ? (
            <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/96 to-transparent px-5 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-8">
              <form onSubmit={submitMessage} className="pointer-events-auto mx-auto max-w-4xl">
                <InputGroup className="border-input bg-background/95 shadow-lg backdrop-blur-sm">
                  <InputGroupTextarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={reply?.questions.some(({ kind }) => kind === "text") ? "Type your answer…" : "Describe what should trigger a Ping…"}
                    aria-label="Message Podex"
                    autoFocus
                    rows={2}
                    disabled={!session || pending}
                  />
                  <InputGroupAddon align="block-end" className="justify-between">
                    <span className="text-caption text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
                    <InputGroupButton type="submit" variant="default" size="icon-sm" aria-label="Send message" disabled={!session || pending || !input.trim()}>
                      {pending ? <Spinner className="motion-reduce:animate-none" /> : <ArrowUp aria-hidden="true" />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            </footer>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CapabilityEvidence({ session }: { session: RuleBuilderSession }) {
  const draft = session.reply.draft;
  if (!draft.capability_id) {
    return session.capability_count ? (
      <div className="mt-4 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <ShieldCheck className="size-4" aria-hidden="true" />
        {session.capability_count} connected {session.capability_count === 1 ? "capability" : "capabilities"} discovered
      </div>
    ) : null;
  }
  return (
    <div className="mt-4 border-y border-border py-3 text-sm">
      <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-4" aria-hidden="true" />
        <span>{draft.capability_name}</span>
      </div>
      {draft.capability_safety === "unannotated" ? (
        <div className="mt-2 flex items-start gap-2 text-amber-700 dark:text-amber-300">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          This MCP does not declare the tool read-only. The definition can be saved, but Podex will not call it during setup.
        </div>
      ) : null}
    </div>
  );
}

function QuestionControl({
  question,
  selected,
  disabled,
  onToggle,
  onSend,
}: {
  question: RuleQuestion;
  selected: string[];
  disabled: boolean;
  onToggle: (value: string) => void;
  onSend: (value: string | string[]) => void;
}) {
  if (question.kind === "text" || !question.options.length) {
    return <p className="mt-4 text-sm text-muted-foreground">{question.prompt}</p>;
  }
  if (question.options.length > 6) {
    return (
      <div className="mt-5 max-w-xl border-y border-border py-4">
        <p className="mb-3 font-medium">{question.prompt}</p>
        <Command className="border border-border bg-background">
          <CommandInput placeholder="Search choices" />
          <CommandList className="max-h-56">
            <CommandEmpty>No choices match.</CommandEmpty>
            {question.options.map((option) => (
              <CommandItem
                key={option.value}
                value={`${option.label} ${option.description}`}
                disabled={disabled}
                onSelect={() => question.kind === "single_select" ? onSend(option.value) : onToggle(option.value)}
              >
                <Check className={selected.includes(option.value) ? "opacity-100" : "opacity-0"} />
                <span>{option.label}</span>
                {option.description ? <span className="ml-auto text-xs text-muted-foreground">{option.description}</span> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        {question.kind === "multi_select" ? (
          <Button className="mt-3" size="sm" onClick={() => onSend(selected)} disabled={disabled || !selected.length}>Send selections</Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mt-5">
      <p className="mb-3 font-medium">{question.prompt}</p>
      <div className="flex flex-wrap gap-2">
        {question.options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <Button
              key={option.value}
              variant={active ? "secondary" : "outline"}
              size="sm"
              title={option.description || undefined}
              disabled={disabled}
              onClick={() => question.kind === "single_select" ? onSend(option.value) : onToggle(option.value)}
            >
              {active ? <Check aria-hidden="true" /> : null}
              {option.label}
            </Button>
          );
        })}
      </div>
      {question.kind === "multi_select" ? (
        <Button className="mt-3" size="sm" onClick={() => onSend(selected)} disabled={disabled || !selected.length}>Send selections</Button>
      ) : null}
    </div>
  );
}

function ConnectionRequirement({
  requirement,
  pending,
  error,
  onConnect,
}: {
  requirement: NonNullable<RuleBuilderReply["connection_requirement"]>;
  pending: boolean;
  error: string;
  onConnect: () => void;
}) {
  return (
    <section className="mt-5 max-w-xl border-y border-border py-5" aria-label="Connection required">
      <div className="flex items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background">
          {requirement.provider === "other" ? <Cable className="size-5" /> : <ProviderLogo provider={requirement.provider} className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-base font-medium">{requirement.label}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{requirement.reason}</p>
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
          <Button className="mt-4" size="sm" onClick={onConnect} disabled={pending}>
            {pending ? <Spinner /> : <Cable />}
            {requirement.provider === "github" || requirement.provider === "gmail" ? `Connect ${providerName(requirement.provider)}` : "Connect a service"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function RuleReview({
  reply,
  podName,
  pending,
  onSave,
}: {
  reply: RuleBuilderReply;
  podName: string;
  pending: boolean;
  onSave: () => void;
}) {
  const definition = reply.draft.definition;
  return (
    <section className="mt-6 max-w-2xl" aria-label="Rule review">
      <Separator />
      <dl className="divide-y divide-border">
        <ReviewRow label="Definition" value={reply.draft.title} />
        <ReviewRow label="Watch" value={reply.draft.intent_summary} />
        <ReviewRow label="Capability" value={reply.draft.capability_name} />
        <ReviewRow label="Scope" value={definitionValue(definition, "source")} />
        <ReviewRow label="When" value={definitionValue(definition, "condition")} />
        <ReviewRow label="Cadence" value={definitionValue(definition, "cadence")} />
        <ReviewRow label="Destination" value={podName} />
        <ReviewRow label="Execution" value="Not running yet" />
      </dl>
      <Button className="mt-5" onClick={onSave} disabled={pending}>
        {pending ? <Spinner /> : <Save />}
        {pending ? "Saving…" : "Save definition"}
      </Button>
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{value || "—"}</dd>
    </div>
  );
}

function AssistantMessage({ children }: { children: React.ReactNode }) {
  return (
    <Message>
      <MessageContent>
        <MessageHeader className="px-0">Podex</MessageHeader>
        <div className="max-w-2xl text-sm leading-6">{children}</div>
      </MessageContent>
    </Message>
  );
}

function UserMessage({ children }: { children: React.ReactNode }) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble><BubbleContent>{children}</BubbleContent></Bubble>
      </MessageContent>
    </Message>
  );
}

function SetupError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const needsSettings = error.toLowerCase().includes("ai settings");
  return (
    <div className="max-w-xl border-y border-destructive/30 py-5">
      <p className="text-sm text-destructive">{error || "The rule builder could not start."}</p>
      <div className="mt-4 flex gap-2">
        {needsSettings ? <Button size="sm" nativeButton={false} render={<Link href="/settings" />}>Configure AI</Button> : null}
        <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}

function definitionValue(definition: Record<string, unknown>, key: string) {
  const value = definition[key];
  if (typeof value === "string") return value;
  if (!value) return "—";
  try {
    return JSON.stringify(value);
  } catch {
    return "Configured";
  }
}

function providerName(provider: "github" | "gmail") {
  return provider === "github" ? "GitHub" : "Gmail";
}

function readStoredSession() {
  return typeof window === "undefined" ? "" : sessionStorage.getItem(RULE_CHAT_SESSION_KEY) ?? "";
}
