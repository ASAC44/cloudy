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
  Radar,
  RotateCcw,
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
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
} from "@/types/api";

export const RULE_CHAT_SESSION_KEY = "podex:rule-builder:v2";

const noStoreSubscription = () => () => undefined;

export function NewPingChat({
  podName,
  userName,
  userAvatarUrl,
  initialOpen = false,
  initialSessionId,
  editingRuleId,
  resumeError = false,
}: {
  podName: string;
  userName: string;
  userAvatarUrl?: string;
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
      userName={userName}
      userAvatarUrl={userAvatarUrl}
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
  userName,
  userAvatarUrl,
  initialOpen,
  resumeId,
  editingRuleId,
  resumeError,
}: {
  podName: string;
  userName: string;
  userAvatarUrl?: string;
  initialOpen: boolean;
  resumeId?: string;
  editingRuleId?: string;
  resumeError: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [session, setSession] = useState<RuleBuilderSession | null>(null);
  const [input, setInput] = useState("");
  const [outgoingMessage, setOutgoingMessage] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [error, setError] = useState(resumeError ? "The connection was not completed. You can retry or continue editing." : "");
  const [complete, setComplete] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const loading = useRef(false);
  const generation = useRef(0);
  const resumeOnce = useRef(resumeId);
  const editingRuleOnce = useRef(editingRuleId);

  useEffect(() => {
    if (!open || session || loading.current) return;
    const currentGeneration = generation.current;
    const sessionId = resumeOnce.current;
    const ruleId = editingRuleOnce.current;
    resumeOnce.current = undefined;
    editingRuleOnce.current = undefined;
    loading.current = true;
    startTransition(async () => {
      const result = sessionId
        ? await getRuleBuilderSession(sessionId)
        : await createRuleBuilderSession(ruleId);
      if (currentGeneration !== generation.current) return;
      loading.current = false;
      if (!result.session) {
        setError(humanizeRuleError(result.error));
        if (result.error?.includes("expired") || result.error?.includes("not found")) {
          sessionStorage.removeItem(RULE_CHAT_SESSION_KEY);
        }
        return;
      }
      setSession(result.session);
      if (sessionId) sessionStorage.removeItem(RULE_CHAT_SESSION_KEY);
      if (initialOpen) window.history.replaceState(null, "", "/home");
    });
  }, [initialOpen, loadAttempt, open, session]);

  function sendTurn(inputValue?: string, answers?: Array<{ question_id: string; value: string | string[] }>) {
    if (!session || pending) return;
    const message = inputValue?.trim();
    if (!message && !answers?.length) return;
    const optimistic = message ?? answers?.flatMap(({ value }) => Array.isArray(value) ? value : [value]).join(", ") ?? "";
    setError("");
    setInput("");
    setOutgoingMessage(optimistic);
    const currentGeneration = generation.current;
    startTransition(async () => {
      const result = await sendRuleBuilderTurn({
        sessionId: session.id,
        revision: session.revision,
        message,
        answers,
      });
      if (currentGeneration !== generation.current) return;
      if (!result.session) {
        setOutgoingMessage("");
        if (message) setInput(message);
        setError(humanizeRuleError(result.error));
        return;
      }
      setSession(result.session);
      setOutgoingMessage("");
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

  function startWatching() {
    if (!session || pending) return;
    setError("");
    const currentGeneration = generation.current;
    startTransition(async () => {
      const result = await commitRuleBuilderSession(session.id, session.revision);
      if (currentGeneration !== generation.current) return;
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
      window.location.assign(`/connections?resume=${encodeURIComponent(session.id)}&connect=${encodeURIComponent(provider)}`);
      return;
    }
    startTransition(async () => {
      const result = await startConnectionOAuth(provider, providerName(provider));
      if (result.authorization_url) window.location.assign(result.authorization_url);
      else setError(result.error ?? `${providerName(provider)} could not be connected.`);
    });
  }

  function clearConversation() {
    generation.current += 1;
    loading.current = false;
    resumeOnce.current = undefined;
    editingRuleOnce.current = undefined;
    sessionStorage.removeItem(RULE_CHAT_SESSION_KEY);
    setSession(null);
    setInput("");
    setOutgoingMessage("");
    setSelected({});
    setError("");
    setComplete(false);
  }

  function newChat() {
    clearConversation();
    setLoadAttempt((current) => current + 1);
    setOpen(true);
  }

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) clearConversation();
    setOpen(nextOpen);
  }

  const reply = session?.reply;
  const transcript = session?.messages ?? [];
  const leadingMessages = transcript.at(-1)?.role === "assistant" ? transcript.slice(0, -1) : transcript;
  const showPingStarters = Boolean(
    session
    && reply
    && !transcript.some(({ role }) => role === "user")
    && !reply.questions.length
    && !reply.connection_requirement
    && reply.phase !== "review",
  );
  const announcement = pending
    ? session ? "Podex is thinking." : "Discovering connected capabilities."
    : complete
      ? `Your Ping is active and will ask ${podName} before any write.`
      : error || reply?.message || "Create a Ping.";

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button type="button" />}>
        Add
        <Plus aria-hidden="true" />
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="inset-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-background p-0 text-foreground ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Create a Ping</DialogTitle>
        <DialogDescription className="sr-only">
          Describe what Podex should watch, answer clarifying questions, and start a reviewed automation.
        </DialogDescription>
        <p className="sr-only" aria-live="polite">{announcement}</p>

        <div className="flex h-full min-h-0 flex-col">
          <header className="absolute inset-x-0 top-0 z-30 flex h-16 items-center justify-between px-5 sm:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Sparkles className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium">{session?.editing_rule_id ? "Edit Ping" : "New Ping"}</p>
                <p className="truncate text-caption text-muted-foreground">Tell Podex what to watch across your connections</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={newChat}>
                <RotateCcw aria-hidden="true" />
                <span className="hidden sm:inline">Start over</span>
              </Button>
              <DialogClose render={<Button variant="ghost" size="icon" aria-label="Close chat" />}>
                <X aria-hidden="true" />
              </DialogClose>
            </div>
          </header>

          <MessageScrollerProvider autoScroll>
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="mx-auto w-full max-w-3xl justify-end px-5 pt-24 pb-40 sm:px-8 sm:pt-28 sm:pb-44">
                  {leadingMessages.map((message, index) => (
                    <MessageScrollerItem key={`${message.role}-${index}`}>
                      {message.role === "user"
                        ? <UserMessage userName={userName} userAvatarUrl={userAvatarUrl}>{message.content}</UserMessage>
                        : <AssistantMessage>{message.content}</AssistantMessage>}
                    </MessageScrollerItem>
                  ))}

                  {!session ? (
                    <MessageScrollerItem>
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
                          <SetupError error={error} onRetry={newChat} />
                        )}
                      </AssistantMessage>
                    </MessageScrollerItem>
                  ) : complete ? (
                    <MessageScrollerItem>
                      <AssistantMessage>
                        <div className="flex items-start gap-3 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                          <div>
                            <p className="font-medium">Your Ping is watching</p>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                              New events will be checked by your selected model. Any write still needs your approval on {podName}.
                            </p>
                            <div className="mt-5 flex flex-wrap gap-2">
                              <Button size="sm" variant="outline" onClick={newChat}><RotateCcw />New Ping</Button>
                              <Button size="sm" nativeButton={false} render={<Link href="/configure" />}>Manage Pings</Button>
                            </div>
                          </div>
                        </div>
                      </AssistantMessage>
                    </MessageScrollerItem>
                  ) : reply ? (
                    <MessageScrollerItem>
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
                        {showPingStarters ? <PingStarterPrompts disabled={pending} onSelect={sendTurn} /> : null}
                        {reply.connection_requirement ? (
                          <ConnectionRequirement
                            requirement={reply.connection_requirement}
                            pending={pending}
                            error={error}
                            onConnect={() => connectProvider(reply.connection_requirement!.provider)}
                          />
                        ) : null}
                        {reply.phase === "review" && reply.draft.ready ? (
                          <RuleReview reply={reply} podName={podName} pending={pending} onSave={startWatching} />
                        ) : null}
                        {error && !reply.connection_requirement ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
                        {pending && !outgoingMessage ? (
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

                  {outgoingMessage ? (
                    <>
                      <MessageScrollerItem>
                        <UserMessage userName={userName} userAvatarUrl={userAvatarUrl}>{outgoingMessage}</UserMessage>
                      </MessageScrollerItem>
                      <MessageScrollerItem>
                        <AssistantMessage>
                          <Attachment state="processing" className="max-w-sm bg-background/60 motion-reduce:[&_.shimmer]:animate-none">
                            <AttachmentMedia><Spinner className="motion-reduce:animate-none" /></AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle>Podex is thinking</AttachmentTitle>
                              <AttachmentDescription>Turning your request into a safe, reviewable automation</AttachmentDescription>
                            </AttachmentContent>
                          </Attachment>
                        </AssistantMessage>
                      </MessageScrollerItem>
                    </>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>

          {!complete ? (
            <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/95 to-transparent px-5 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-8">
              <form onSubmit={submitMessage} className="pointer-events-auto mx-auto max-w-3xl">
                <InputGroup className="border-border bg-white shadow-lg has-disabled:bg-white has-disabled:opacity-100 dark:bg-background dark:has-disabled:bg-background">
                  <InputGroupTextarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={reply?.questions.some(({ kind }) => kind === "text") ? "Type your answer…" : "Describe what should trigger a Ping…"}
                    aria-label="Message Podex"
                    autoFocus
                    rows={2}
                    disabled={!session || pending}
                    className="placeholder:text-muted-foreground disabled:text-muted-foreground"
                  />
                  <InputGroupAddon align="block-end" className="justify-between text-muted-foreground">
                    <span className="text-caption">Enter to send · Shift+Enter for a new line</span>
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

const PING_STARTERS = [
  "Watch my Telegram DMs and draft replies to messages that need me",
  "Ping me when a new pull request needs my review",
  "Watch for important emails from OpenAI",
];

function PingStarterPrompts({ disabled, onSelect }: { disabled: boolean; onSelect: (message: string) => void }) {
  return (
    <div className="mt-6 border-y border-border py-4">
      <p className="mb-3 text-caption font-medium uppercase tracking-[0.12em] text-muted-foreground">Try an example</p>
      <div className="flex flex-col items-start gap-2">
        {PING_STARTERS.map((prompt) => (
          <Button key={prompt} variant="ghost" className="h-auto w-full min-w-0 justify-start whitespace-normal px-0 py-1 text-left font-normal hover:bg-transparent hover:text-clay" disabled={disabled} onClick={() => onSelect(prompt)}>
            <ArrowUp className="size-3.5 rotate-45" aria-hidden="true" />
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function CapabilityEvidence({ session }: { session: RuleBuilderSession }) {
  const draft = session.reply.draft;
  if (!draft.capability_id) return null;
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
            {requirement.provider === "other" ? "Connect a service" : `Connect ${providerLabel(requirement.provider)}`}
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
    <section className="mt-6 max-w-2xl" aria-label="Ping review">
      <Separator />
      <dl className="divide-y divide-border">
        <ReviewRow label="Name" value={reply.draft.title} />
        <ReviewRow label="Purpose" value={reply.draft.intent_summary} />
        <ReviewRow label="Source" value={reply.draft.capability_name} />
        <ReviewRow label="Scope" value={definitionValue(definition, "scope")} />
        <ReviewRow label="Match when" value={definitionValue(definition, "match")} />
        <ReviewRow label="Context" value={definitionValue(definition, "context")} />
        <ReviewRow label="Action" value={definitionValue(definition, "action")} />
        <ReviewRow label="Cadence" value={definitionValue(definition, "cadence")} />
        <ReviewRow label="Approval" value="Every write needs approval on your Pod" />
        <ReviewRow label="Destination" value={podName} />
        <ReviewRow label="New events" value="Starts from now; historical items are ignored" />
      </dl>
      <Button className="mt-5" onClick={onSave} disabled={pending}>
        {pending ? <Spinner /> : <Radar />}
        {pending ? "Starting…" : "Start watching"}
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
    <Message className="items-start gap-3">
      <MessageAvatar className="self-start bg-transparent">
        <Avatar size="sm" className="size-7">
          <AvatarImage src="/podex-mascot.png" alt="" />
          <AvatarFallback>P</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent className="min-w-0 max-w-2xl flex-1">
        <MessageHeader className="px-0">Podex</MessageHeader>
        <div className="text-sm leading-6">{children}</div>
      </MessageContent>
    </Message>
  );
}

function UserMessage({
  children,
  userName,
  userAvatarUrl,
}: {
  children: React.ReactNode;
  userName: string;
  userAvatarUrl?: string;
}) {
  return (
    <Message align="end" className="items-end gap-3">
      <MessageAvatar className="self-end bg-transparent">
        <Avatar size="sm" className="size-7">
          {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
          <AvatarFallback>{userInitials(userName)}</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent className="min-w-0 max-w-2xl items-end">
        <MessageHeader className="justify-end px-0">{userName}</MessageHeader>
        <Bubble><BubbleContent>{children}</BubbleContent></Bubble>
      </MessageContent>
    </Message>
  );
}

function userInitials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U";
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

function providerLabel(provider: ConnectionProvider) {
  return provider === "custom_mcp"
    ? "Custom MCP"
    : provider.charAt(0).toUpperCase() + provider.slice(1);
}

function readStoredSession() {
  return typeof window === "undefined" ? "" : sessionStorage.getItem(RULE_CHAT_SESSION_KEY) ?? "";
}
