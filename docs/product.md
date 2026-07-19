# Podex

Podex is a pocket-sized human-in-the-loop Pod for approving, rejecting, or responding to actions proposed by AI agents and automated workflows without opening a phone or computer.

## Core interaction

An agent prepares an action and sends a decision request to Podex. The Pod shows the relevant context on its 2.8-inch screen. The user can:

- Press **Approve** to authorize the action.
- Press **Reject** to stop the action.
- Hold both buttons to dictate a response or instruction through the microphone.

The connected agent or workflow performs the action. Podex is the decision interface, not the system executing it.

## Pod hardware

- Small cuboid keychain form
- Raspberry Pi Zero 2 W
- 2.8-inch screen
- Approve and Reject buttons
- Microphone for dictation
- No speaker
- Wireless network connection

## Decision details

Each request shows enough information to make a safe decision, including:

- The proposed action
- The requesting agent or workflow
- A concise summary and supporting details
- The people, services, or data affected
- Risk, warnings, and expiration time when relevant

## Integrations

Podex can receive approval requests from any system that supports a webhook or API, including n8n HITL nodes, email agents, GitHub workflows, Discord, WhatsApp, Notion, and internal tools.

Example actions include:

- Approving and merging a pull request
- Reviewing and sending a drafted email reply
- Adding a detected event to Notion
- Authorizing a deployment or workflow step
- Rejecting an unwanted or risky action

## Email personalization

The goal is not “write a good email.” It is: **predict what this specific user would have written to this specific person.**

Podex combines live information with remembered context. Live sources provide the current email thread, calendar availability, pull request status, and other changing facts. Learned context provides the user's writing style, relationships, projects, commitments, and previously approved or corrected responses.

This allows the same request to produce a different response when the user's situation changes. A meeting reply may change from no to yes when the calendar becomes free, while still sounding like the user.

## Dashboard

A web dashboard is used to connect services, configure agents and workflows, manage permissions, and control which actions require approval.

## Product principle

Agents do the work. Podex keeps the user in control at the moment a decision matters.
