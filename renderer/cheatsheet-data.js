/**
 * Interview Cheat Sheet — pre-written, conversational English answers for
 * common AI/LLM/agent engineering questions.
 *
 * Style rules (match the rest of the app):
 *   • First person, spoken cadence ("what I do is", "the way I handle that").
 *   • Paragraphs separated by ONE BLANK LINE so the user knows where to pause.
 *   • Numbers as words ("twenty thousand documents", not "20,000 documents").
 *   • No bullets, no headers, no code blocks. Pure prose, ready to recite.
 *   • Length around 3-4 paragraphs, ~150-250 words each.
 *
 * Topics are grouped by category just for the UI grid; the JS doesn't care
 * about category, it's display-only.
 */
window.CHEATSHEET_TOPICS = [
  // ─────────────────────── RAG & Retrieval ───────────────────────
  {
    id: 'rag',
    title: 'RAG implementation',
    category: 'Retrieval',
    icon: '🔍',
    keywords: ['rag', 'retrieval', 'augmented', 'generation'],
    script:
`So when I implement RAG in my agents, the basic idea is simple but the execution is where it gets interesting. The agent doesn't have all the knowledge baked into the prompt, because that would be expensive and impossible at scale. Instead, when a user asks something, I first retrieve the most relevant pieces from a knowledge base, and then I pass only those pieces to the model along with the question.

The retrieval part is where I use embeddings. Every document or chunk in my knowledge base gets converted into a vector, basically a list of numbers that represents the meaning. When a user query comes in, I embed the query the same way and search for the closest vectors. That gives me the top matches semantically, not just keyword matches.

Then I take those top three to five chunks, put them in the prompt as context, and let the model generate the answer grounded in that retrieved information. The big win is the model stays focused on real data and hallucinates way less. The trade-off is you need to chunk well, embed well, and keep the index fresh, otherwise the retrieval surfaces garbage and the answer follows.`
  },
  {
    id: 'rag-vs-finetuning',
    title: 'RAG vs Fine-tuning',
    category: 'Retrieval',
    icon: '⚖️',
    keywords: ['rag', 'fine-tuning', 'finetuning', 'training'],
    script:
`This comes up a lot. The way I think about it is, RAG is for knowledge that changes, fine-tuning is for behavior that doesn't. If the information the user is asking about could be updated tomorrow, like product docs, internal wiki, or recent data, that goes in a vector store and you retrieve it. Fine-tuning that data into the model means you'd have to retrain every time it changes, which is impractical.

Fine-tuning is for teaching the model how to do something consistently — a specific output format, a specific tone, a specific domain language. Those don't change frequently, so baking them into the weights is fine. Most production setups end up using both. The model is fine-tuned for the style and the workflow, and RAG provides the live knowledge.

Sometimes I see teams reach for fine-tuning when they actually need better retrieval, and that's an expensive mistake. So the question I always ask first is, would better retrieval solve this, before even considering fine-tuning.`
  },
  {
    id: 'hybrid-search',
    title: 'Hybrid search',
    category: 'Retrieval',
    icon: '🧬',
    keywords: ['hybrid', 'search', 'bm25', 'vector', 'keyword'],
    script:
`Hybrid search is when I combine semantic search with keyword search in the same pipeline. Pure semantic search is great for understanding meaning, but it misses cases where the exact word matters, like a specific product code, an error message, or a person's name. Pure keyword search catches those, but it's blind to synonyms and rephrasing.

What I do in practice is run both queries in parallel against the same corpus. The semantic side uses vector similarity, the keyword side uses something like BM25 or a classic full-text index. Each returns a ranked list of results, and then I merge them.

The merging step matters. The simplest way is reciprocal rank fusion, which just combines the ranks without trusting either score as an absolute number. It works surprisingly well out of the box. For higher-stakes use cases I add a reranker on top, a smaller model that takes the top fifty candidates from the fused list and reorders them based on relevance to the actual query. That last step usually gives me the biggest jump in quality.`
  },

  // ─────────────────────── Frameworks & Tooling ───────────────────────
  {
    id: 'langchain',
    title: 'LangChain',
    category: 'Frameworks',
    icon: '🦜',
    keywords: ['langchain', 'chain', 'agent', 'framework'],
    script:
`LangChain I use as the orchestration layer, basically the glue that holds the agent together. What it gives you is a clean way to chain steps together — take the user input, decide which tool to call, call it, parse the result, feed it back into the model, and so on. Without it you end up writing a lot of boilerplate yourself.

The core pieces I rely on are chains, agents, and tools. A chain is just a fixed sequence of steps. An agent is a loop where the model itself decides what to do next based on the previous output, so it's more dynamic. Tools are the functions the agent can call — search this database, call this API, run this calculation.

What I appreciate about LangChain is that the integrations come ready, so I don't reinvent connectors for each vector store, each model provider, each parser. The downside is that it adds a layer of abstraction, so when something breaks you sometimes have to dig through their code to understand why. For production I tend to keep my chains simple and lean on the building blocks rather than the heavy abstractions.`
  },
  {
    id: 'langfuse',
    title: 'Langfuse',
    category: 'Frameworks',
    icon: '📈',
    keywords: ['langfuse', 'observability', 'tracing', 'monitoring'],
    script:
`Langfuse is what I use for observability on top of the LLM calls. The problem with agents is they're a black box once they're running, so without proper tracing you don't know why a specific response came out the way it did, or which step took two seconds versus two hundred milliseconds.

What Langfuse gives me is a full trace of each interaction. I see every prompt sent to the model, every response, every tool call, every retrieval, with latency and token count for each step. That makes debugging an order of magnitude easier, especially when something goes wrong intermittently.

It also tracks cost, which matters a lot when you're running thousands of calls a day. I can see which workflows are expensive, which model is being used where, and I can spot prompt regressions quickly. I usually wire it in from day one because retrofitting observability later is painful.`
  },
  {
    id: 'mcp',
    title: 'MCP (Model Context Protocol)',
    category: 'Frameworks',
    icon: '🔌',
    keywords: ['mcp', 'model context protocol', 'anthropic', 'tools'],
    script:
`MCP, or Model Context Protocol, is the open standard from Anthropic for connecting AI applications to external tools and data sources. The problem it solves is that every time you wanted to give a model access to a new system — Slack, Gmail, a database, a code repo — you had to write a custom integration. MCP standardizes that.

The way it works is that each tool or data source exposes itself as an MCP server. Any MCP-compatible client, like Claude Desktop or an agent framework, can then talk to that server using the same protocol. It handles auth, tool discovery, streaming, all of that.

What I like about it is the composability. I can plug in a new MCP server and immediately my agent has new capabilities, without changing any of my agent code. It's still relatively new but adoption is moving fast, and I expect it to become the default way of building tool ecosystems.`
  },

  // ─────────────────────── Embeddings & Chunks ───────────────────────
  {
    id: 'chunks',
    title: 'Chunking strategy',
    category: 'Data',
    icon: '✂️',
    keywords: ['chunks', 'chunking', 'split', 'document'],
    script:
`Chunking is one of those things that sounds trivial but actually moves the needle a lot. The basic problem is that your source documents are too big to embed as a single vector, so you split them — but how you split them changes everything downstream.

The naive way is fixed-size chunks, like five hundred tokens with a fifty-token overlap. That works as a baseline. But for technical documents I prefer semantic chunking, which means splitting on natural boundaries like sections, paragraphs, or code blocks. That way each chunk is a coherent idea and the embedding represents something meaningful.

The other thing I pay attention to is overlap. If a sentence falls on the boundary, you can lose context in both chunks. Adding a small overlap of maybe ten or twenty percent helps stitch the meaning together. And then I tune chunk size to the model's context window. Too small and the model gets fragmented information, too big and the retrieval becomes imprecise.`
  },
  {
    id: 'embeddings',
    title: 'Embeddings',
    category: 'Data',
    icon: '🧮',
    keywords: ['embeddings', 'vector', 'representation'],
    script:
`Embeddings are the foundation of everything semantic in my agents. The idea is you take a piece of text, run it through an embedding model, and you get back a vector — basically a list of around fifteen hundred or three thousand numbers, depending on the model. Texts with similar meaning end up with similar vectors, so you can measure distance between them and find what's related.

I use different embedding models depending on the case. For most production work I use OpenAI's text embedding model, like text-embedding-three-large, because it's fast, cheap, and the quality is reliable. For domain-specific stuff, sometimes a smaller open-source model fine-tuned on the domain beats a generic one.

One thing people overlook is keeping embeddings fresh. If you change models, you have to re-embed everything, because vectors from different models live in completely different spaces and can't be compared. So I version my embeddings and I plan for re-indexing whenever I upgrade the model.`
  },

  // ─────────────────────── Databases ───────────────────────
  {
    id: 'databases',
    title: 'Databases for AI apps',
    category: 'Databases',
    icon: '🗄',
    keywords: ['database', 'postgres', 'mongo', 'sql'],
    script:
`For databases in AI applications I tend to use a hybrid setup. Relational databases like Postgres handle the structured stuff — user records, sessions, audit logs, transactions, anything where I need ACID guarantees and complex joins.

But the moment I'm dealing with semantic data, like document embeddings or user queries that need similarity search, I reach for a vector store. Sometimes that's a dedicated vector database like Pinecone or Qdrant, but more often I just use pgvector inside Postgres, because it keeps everything in one place and the performance is good enough for most use cases.

The reason I like pgvector specifically is that I can do hybrid queries — filter by metadata in SQL and then rank by vector similarity in the same query. So I can say, give me the ten most relevant documents from this user, in this language, created in the last thirty days, ranked by semantic similarity to this query. That's the kind of query you can't do cleanly with two separate databases.`
  },
  {
    id: 'hybrid-db',
    title: 'Hybrid databases',
    category: 'Databases',
    icon: '🧱',
    keywords: ['hybrid', 'database', 'vector', 'relational'],
    script:
`Hybrid databases are basically combining relational and vector search in a single system, or in tightly coordinated systems. The case for them is real. Pure vector search gives you semantic relevance but no metadata filtering. Pure relational gives you precise filtering but no understanding of meaning.

In a real application you almost always want both. Imagine a customer support agent. The user asks, what's the status of my last order. You need vector search to understand what they're asking, but you also need a hard filter on user identity to make sure you don't pull someone else's order. That's where hybrid shines.

In practice I implement it two ways. Either I use a single store like pgvector that supports both natively, or I run two stores in parallel and combine the results, using something called reciprocal rank fusion to merge the rankings. The first option is simpler, the second is more powerful but adds latency and complexity.`
  },
  {
    id: 'vector-db',
    title: 'Vector databases',
    category: 'Databases',
    icon: '📦',
    keywords: ['vector', 'database', 'pinecone', 'qdrant', 'pgvector'],
    script:
`A vector database is a store optimized for similarity search over high-dimensional vectors. Instead of asking, give me the rows where this column equals that value, you ask, give me the rows whose vectors are closest to this query vector. Under the hood they use indexes like HNSW or IVF that make that search fast even over millions of items.

The ones I've used the most are Pinecone, Qdrant, and pgvector inside Postgres. Pinecone is fully managed and dead simple to start with, you don't think about infrastructure. Qdrant is open source and very capable if you want to self-host. Pgvector I lean on when I want to keep everything in Postgres and have hybrid relational plus vector queries in the same place.

The choice depends on scale and ops appetite. For small to medium workloads pgvector is usually enough and saves you a service. Once you're at hundreds of millions of vectors or you need very low latency at high QPS, a dedicated vector store starts to make sense.`
  },

  // ─────────────────────── Prompting & Agents ───────────────────────
  {
    id: 'system-prompt',
    title: 'System prompts',
    category: 'Prompting',
    icon: '📝',
    keywords: ['system prompt', 'prompt engineering', 'instructions'],
    script:
`System prompts are where most of the agent's behavior actually lives. People think the magic is in the model, but ninety percent of the difference between a good agent and a bad one is the system prompt and the structure around it.

The way I write system prompts is, I treat them as the contract with the model. I tell it exactly what role it's playing, what tools it has, what format I want the output in, what to do when it doesn't know something, and what to never do. I always include examples, because models learn from examples way better than from rules. A few well-chosen examples beat ten paragraphs of explanation.

I also iterate constantly. I have a small eval set, like twenty or thirty representative cases, and every time I change the prompt I run the eval and look at what got better and what regressed. Without that feedback loop you're just guessing.`
  },
  {
    id: 'context',
    title: 'Context window',
    category: 'Prompting',
    icon: '🪟',
    keywords: ['context', 'window', 'tokens', 'budget'],
    script:
`Context window management is basically deciding what makes it into the prompt and what doesn't. Modern models have huge windows now, like one or two hundred thousand tokens, but bigger isn't always better. You pay for every token in cost and latency, and the model's attention degrades over very long contexts.

What I do is treat the context window as a budget. The system prompt gets a fixed slice, the retrieved knowledge gets another slice, the conversation history gets the rest, and I have a clear hierarchy of what to drop first when I need to trim. Usually I summarize old conversation turns rather than truncate them, so the agent doesn't lose memory of what happened earlier.

Another trick I use is prompt caching. The static parts of the prompt, like instructions and tool definitions, get cached on the provider side, so I only pay full price the first time. That cuts cost a lot when you have a long system prompt that doesn't change between calls.`
  },
  {
    id: 'agents',
    title: 'Multi-agent systems',
    category: 'Agents',
    icon: '🤝',
    keywords: ['agent', 'multi-agent', 'orchestration', 'planner'],
    script:
`Multi-agent systems are where I split the work across specialized agents instead of having one big general agent do everything. The reasoning is simple — a single agent with twenty tools and a long prompt gets confused. Two or three specialized agents with focused prompts and a clear handoff structure perform much better.

The typical pattern I use is a router or planner at the top, which looks at the user request and decides which specialist to call. Each specialist has its own domain — one for retrieval, one for code execution, one for writing, whatever the case needs. The planner then assembles the final answer from the pieces.

The challenge with multi-agent is coordination. You have to define the handoffs carefully, otherwise you get loops where two agents bounce a problem back and forth without progress. I usually enforce a hard step limit and clear termination conditions so the system can't run forever.`
  },
  {
    id: 'tools',
    title: 'Tool / function calling',
    category: 'Agents',
    icon: '🛠',
    keywords: ['tools', 'function calling', 'tool use'],
    script:
`Tool calling is how I give the agent the ability to do things in the real world, not just generate text. I define a set of functions with a name, a description, and an input schema, and the model decides when and how to call them.

The trick is in the function descriptions. The model only knows what each tool does from the description I write, so I treat those like mini system prompts. I describe exactly when to use the tool, what arguments to pass, what it returns, and any edge cases. Vague descriptions lead to the model calling the wrong tool or passing garbage arguments.

After the model decides to call a tool, my code executes it, I take the result, and feed it back into the conversation so the model can use it. The loop continues until the model decides it has enough information to give a final answer.`
  },
  {
    id: 'memory',
    title: 'Memory (short / long term)',
    category: 'Agents',
    icon: '🧠',
    keywords: ['memory', 'short term', 'long term', 'session'],
    script:
`Memory in agents splits into short-term and long-term, and I handle them very differently. Short-term memory is the current conversation. The model already sees it as part of the context window, so the main job is deciding what to keep verbatim and what to summarize when the conversation gets long.

Long-term memory is what survives across sessions. The user comes back tomorrow, and the agent should remember their preferences, their previous projects, the corrections they made last time. I implement that as a separate store, usually a vector database with structured metadata. After each session I extract the durable facts — user said this, preferred that, corrected this other thing — and write them to the memory store.

When a new conversation starts, I retrieve the relevant memories based on the current query and inject them into the system prompt. That way the agent feels continuous instead of starting from zero each time. The hard part is curation, because you can't store everything, so you need rules for what's worth remembering.`
  },

  // ─────────────────────── Ops, Quality, Cost ───────────────────────
  {
    id: 'streaming',
    title: 'Streaming responses',
    category: 'Ops',
    icon: '〰️',
    keywords: ['streaming', 'sse', 'websocket', 'realtime'],
    script:
`Streaming is critical for user experience in any chat-like interface. Without it, the user waits five or ten seconds staring at a spinner, and that feels broken. With streaming, they see the first token within a hundred milliseconds and the response unfolds in real time, which feels alive.

The way it works under the hood is the model sends tokens as it generates them, I parse them server-side, forward them through a websocket or server-sent events to the frontend, and the frontend appends each chunk to the visible response. The trickier part is handling tool calls mid-stream, because you have to pause the visible stream, execute the tool, and resume.

I also use streaming for cost reasons. If the user reads halfway through a long response and realizes it's not what they wanted, they can cancel and I stop paying for the rest of the tokens. That's a real saving at scale.`
  },
  {
    id: 'caching',
    title: 'Prompt caching',
    category: 'Ops',
    icon: '⚡',
    keywords: ['caching', 'prompt cache', 'cost'],
    script:
`Prompt caching is one of the easiest wins for cost and latency. The idea is that large parts of your prompt — system instructions, tool definitions, retrieved documents that don't change between calls — are repeated over and over. The provider can cache those parts on their side, and on subsequent calls you pay a fraction of the price and get a faster response.

With Anthropic specifically, I mark a cache breakpoint in the prompt, usually after the system prompt and tool definitions, and from then on the first call costs a bit more to populate the cache and every subsequent call within roughly five minutes is much cheaper. I've seen cost reductions of seventy or eighty percent on workloads with stable instructions and variable user inputs.

The trade-off is the cache window, usually around five minutes, so it only helps for high-frequency workflows. For occasional calls it doesn't matter. But for any chatbot or repeated agent loop, it's a no-brainer.`
  },
  {
    id: 'evals',
    title: 'Evaluating agents',
    category: 'Ops',
    icon: '✅',
    keywords: ['eval', 'evaluation', 'testing', 'quality'],
    script:
`Evaluating agents is harder than evaluating regular software because the output is open-ended. You can't just check if a function returned the right number, you have to judge if a generated answer is good. So the approach I take is layered.

At the base I have unit-style evals — a fixed set of inputs and expected behaviors, like, for this question the agent must call this tool first, for this question it must refuse to answer. Those run on every change. Then I have golden-set evals, maybe a hundred real user queries with manually graded reference answers. I run those weekly and track regressions.

For subjective quality I use LLM-as-judge. I send the agent's answer plus the question to a stronger model and ask it to score the answer on relevance, accuracy, and completeness. It's not perfect, but it scales much better than human grading. And finally, in production I sample real interactions, label them, and feed them back into the eval set so it stays representative.`
  },
  {
    id: 'cost',
    title: 'Cost / token budgets',
    category: 'Ops',
    icon: '💰',
    keywords: ['cost', 'tokens', 'budget', 'rate limit'],
    script:
`Cost management for LLM apps is non-negotiable once you go to production. A careless agent can burn through a thousand dollars a day without anyone noticing. So I build budgets into the system from day one.

At the request level, I set a maximum token limit per call, so even if the model wants to ramble, I cap it. At the user level, I track token consumption per user per day and rate-limit accordingly. At the workflow level, I have circuit breakers — if a multi-step agent loop is about to exceed its budget, it stops and returns a partial result instead of continuing.

I also choose models strategically. Not every step needs the most expensive model. I route easy steps to a cheaper, faster model, and reserve the top-tier model for the complex reasoning steps. And I lean hard on prompt caching, like I mentioned earlier.`
  },
  {
    id: 'guardrails',
    title: 'Guardrails / safety',
    category: 'Ops',
    icon: '🛡',
    keywords: ['guardrails', 'safety', 'prompt injection', 'security'],
    script:
`Guardrails are what keep the agent from doing or saying things you don't want, no matter how creative the user gets. I implement them at multiple layers because no single layer is reliable on its own.

At the prompt level, I include explicit rules in the system prompt about what the agent can and cannot do, with examples of refusals. At the input level, I run user inputs through a quick classifier to catch obvious abuse — prompt injection attempts, off-topic requests, attempts to extract the system prompt. At the output level, I check the generated response before sending it to the user, especially for things like PII leakage or policy violations.

I also constrain tool use carefully. The agent might have access to a tool that can delete records or send emails, so I either require human confirmation for high-impact actions, or I scope the tools so they physically can't do harmful things. Belt and suspenders, basically.`
  },

  // ─────────────────────── Advanced ───────────────────────
  {
    id: 'multimodal',
    title: 'Multimodal',
    category: 'Advanced',
    icon: '🖼',
    keywords: ['multimodal', 'image', 'vision', 'audio'],
    script:
`Multimodal means the model accepts and reasons over more than just text, usually images, sometimes audio or video. I use it a lot for agents that need to understand screenshots, charts, or documents that come in as PDFs with mixed content.

The way I handle it is, for any input that's not text, I either pass it directly to a multimodal model like Claude or GPT-4o, or I pre-process it into text using an OCR or transcription step and then pass the text. The direct multimodal path is usually better because the model sees the visual structure — layout, color, chart axes — not just the extracted text.

The trade-offs are cost and latency — multimodal calls are usually more expensive than text-only — and prompt design, because you have to be clear about which image you're referring to when you have multiple. I always label images explicitly in the prompt, like saying, the first image is the chart from January, the second is February.`
  },
  {
    id: 'reasoning',
    title: 'Extended thinking / reasoning',
    category: 'Advanced',
    icon: '🤔',
    keywords: ['reasoning', 'thinking', 'cot', 'chain of thought'],
    script:
`Extended thinking, sometimes called reasoning mode, is when the model spends extra compute generating internal thoughts before giving its final answer. The output you see is the answer, but behind the scenes there's a much longer chain of reasoning the model goes through to get there.

I use it for hard problems where the gain in quality justifies the extra latency and cost. Math problems, multi-step planning, deep analysis of a complex dataset — those are the cases where extended thinking really pays off. For simple chitchat or direct factual questions, it's overkill.

The pattern I follow is, by default I use the standard mode for low-stakes calls, and I flip to extended thinking only on the high-stakes steps. So a multi-agent pipeline might have most agents in standard mode and only the planner or the final reviewer using extended thinking. That keeps the bill manageable while still getting the best output where it matters.`
  },
  {
    id: 'finetuning',
    title: 'Fine-tuning vs prompting',
    category: 'Advanced',
    icon: '🎯',
    keywords: ['fine-tuning', 'prompting', 'training'],
    script:
`Fine-tuning versus prompting is a decision I revisit for each project. The default I reach for is prompting, because it's faster to iterate, you don't need training data or infrastructure, and modern models are flexible enough that good prompts and few-shot examples cover most use cases.

I consider fine-tuning when one of three things is true. Either I have very specific output format requirements that the model keeps drifting from. Or my domain has a vocabulary or style that the base model doesn't know well. Or the latency or cost of prompting at scale is too high, and a fine-tuned smaller model would be both cheaper and faster.

Even when I fine-tune, I treat it as complementary to prompting, not a replacement. A fine-tuned model still needs a clear system prompt and good examples in context. And I never fine-tune without a baseline — I always compare against a strong prompted version of the same workflow first, because sometimes a better prompt closes the gap entirely.`
  },

  // ─────────────────────── Real Project Case Studies ───────────────────────
  {
    id: 'mutor-tracking',
    title: 'WhatsApp shipment tracking (Mutor)',
    category: 'Agents',
    icon: '📦',
    keywords: ['whatsapp', 'tracking', 'shipment', 'multi-tenant', 'mutor', 'aggregator', 'webhook'],
    script:
`For shipment tracking inside a WhatsApp sales bot, the architecture I went with is built around a multi-carrier aggregator with an API and webhooks, not scraping. The user pastes a tracking number however it comes — naked, surrounded by text, even inside a forwarded confirmation email — and the bot reads it and replies in natural Spanish. Zero commands, zero menus, the conversation is the interface. I rejected scraping from day one because Argentina alone has at least five carriers, and scraping all of them is technical debt that breaks every two weeks with terms-of-service bans, captchas, and layout changes.

For detection I run a cheap regex pre-filter so the heavy model isn't invoked on every "hola". When a candidate matches one of the carrier formats, Claude gets called with tool use, extracts the clean number from the messy text, and calls a get tracking info function. The interesting disambiguation problem is that Andreani and Vía Cargo both use twelve-digit numbers, so format alone is ambiguous. The way I solve it is multi-tenant — each tenant declares which carriers they ship with, so a tenant that only uses Andreani has zero ambiguity. If they use both, the backend just hits both APIs in parallel and returns whichever resolves. The user never sees the question.

The real differentiator over a generic tracker is proactive notifications. After the first successful lookup, the bot offers to ping the user on WhatsApp when the package moves. If they accept, I register a webhook with the aggregator, and when the provider pushes an update, a handler maps the tracking number back to the conversation and fires a message. Anti-spam matters, so I only notify on milestone events — dispatched, out for delivery, delivered, exception — and because WhatsApp Business has a twenty-four-hour session window, I use approved template messages for anything sent outside that window.`
  },
  {
    id: 'tenant-config',
    title: 'Multi-tenant config & disambiguation',
    category: 'Agents',
    icon: '🏢',
    keywords: ['multi-tenant', 'tenant', 'config', 'disambiguation', 'mutor'],
    script:
`Multi-tenant means I'm running the same agent for many different businesses out of one codebase, and the trick is making each tenant feel like the bot was built just for them. Every tenant has a config record with their tone, their product catalogue, their integrations, their carriers, and any custom rules. The agent's system prompt and tool set get assembled per request from that config, so a single deploy serves all of them.

The clever part is using the tenant config to solve problems that would otherwise need user input. A great example is shipment tracking — Andreani and Vía Cargo both use twelve-digit numbers, which on a generic tracker would force you to ask the user "which carrier is this from?". In my setup, the tenant has already declared which carriers they ship with, so the ambiguity collapses for free. If a tenant only ships Andreani, twelve digits equals Andreani, period. If they use both, the backend just queries both APIs in parallel and returns whichever resolves. Friction stays at zero.

That same idea applies everywhere — tone of voice, available products, payment methods, opening hours, FAQ overrides — all driven by the tenant config rather than asking the user or hardcoding it. The win is operational. Onboarding a new tenant becomes a config change, not a code change, and I can roll out fifty tenants without touching the agent code once.`
  }
];
