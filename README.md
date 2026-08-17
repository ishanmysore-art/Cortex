# Cortex

**An AI system that builds a living, evidence-backed model of how you think.**

> **Status:** Active development

Most knowledge tools remember what you wrote. Cortex is an experiment in understanding **how your thinking evolves**.

Instead of treating documents and conversations as a static knowledge base, Cortex builds a structured model of the concepts, claims, and ideas you encounter over time. It uses that model to surface connections, contradictions, recurring patterns, and changes in your thinking — while keeping its conclusions grounded in the original evidence.

## Why Cortex?

Traditional note-taking and RAG systems are primarily retrieval systems: you store information, ask a question, and get relevant information back.

Cortex is built around a different question:

**What if an AI system could develop an evolving model of what you know, what you believe, and how those ideas change over time?**

The goal is a system that can move beyond answering questions about stored information and begin identifying patterns the user may not have explicitly noticed.

For example:

- How has my understanding of a topic changed over the past six months?
- Which ideas keep appearing across otherwise unrelated work?
- Where do my current claims conflict with things I've previously written?
- What concepts do I frequently encounter but rarely develop further?
- What connections exist between ideas from different projects or domains?

Crucially, Cortex is designed so these inferences remain **inspectable, evidence-backed, confidence-aware, and correctable**.

## How It Works

Cortex currently models information across several layers:

### Sources

Users upload documents that are extracted, chunked, embedded, and indexed for semantic retrieval.

### Observations

Interactions with information become durable observations, creating a chronological record of what the user encounters and uses.

### Concepts

Cortex identifies recurring concepts across sources and interactions, links them to grounded mentions, and tracks when and where they appear.

### Claims

Explicit claims made by the user are extracted separately from general concepts and linked directly to the evidence that supports them.

### Knowledge States

Cortex maintains evolving representations of the user's relationship with different concepts, including when they were first and last encountered and how frequently they appear or are retrieved.

Together, these layers form the foundation for evidence-backed inference about how the user's thinking develops over time.

## Evidence First

A system that models someone's thinking should be able to explain **why** it believes something about them.

Cortex therefore treats provenance as a core architectural constraint rather than an add-on.

Derived information is designed to remain connected to its underlying evidence, allowing users to inspect where an inference came from, evaluate its confidence, and eventually correct the model when it gets something wrong.

The goal is not for Cortex to declare what a user thinks.

The goal is for it to say:

**"Here's a pattern I noticed. Here's the evidence behind it. Does this seem right?"**

## Architecture

Cortex is built as a full-stack web application using:

- **Next.js + TypeScript** — application and API layer
- **React + Tailwind CSS** — frontend
- **Supabase Auth** — authentication
- **PostgreSQL** — structured persistence
- **pgvector** — vector similarity search
- **HNSW indexing** — efficient semantic retrieval
- **OpenAI embeddings** — document and knowledge representations
- **PGlite** — isolated database and migration testing

The system currently includes pipelines for document ingestion, chunking, embedding, semantic retrieval, observation logging, concept extraction and deduplication, claim extraction, evidence attribution, and knowledge-state projection.

## Current Capabilities

Cortex currently supports:

- Document ingestion for PDF, Markdown, and text files
- Semantic search over uploaded knowledge
- AI-assisted Q&A with source citations
- Persistent observation tracking
- Canonical concept extraction and grounded mentions
- Explicit claim extraction with source spans
- Evidence linking and provenance tracking
- Per-concept knowledge-state projections
- Temporal tracking of encounters and retrievals
- Row-level security and user-isolated data
- Automated database, migration, and application testing

## Design Principles

### 1. Evidence over speculation

Important conclusions should be traceable to the information that produced them.

### 2. Time matters

What someone thinks today is not necessarily what they thought six months ago. Cortex treats knowledge as something that evolves rather than a static profile.

### 3. Inferences should be inspectable

Users should be able to understand why Cortex reached a conclusion.

### 4. The user remains authoritative

Cortex can suggest patterns and interpretations, but the user should ultimately be able to confirm, reject, or correct them.

### 5. Memory should create new value

Remembering information is useful. The larger goal is to use accumulated evidence to discover something the user did not already explicitly record.

## Roadmap

Cortex is actively evolving toward deeper evidence-backed inference and longitudinal reasoning.

Current areas of exploration include:

- Detecting relationships between concepts across sources
- Identifying contradictions and changes in stated beliefs
- Surfacing recurring intellectual patterns
- Modeling trajectories in how concepts develop over time
- Confidence-aware inference
- User correction and feedback mechanisms
- Proactive discovery of useful connections
- Personalized representations of how different users learn and reason

## Development

### Prerequisites

- Node.js
- npm
- Supabase project

### Setup

```bash
git clone <repository-url>
cd cortex
npm install
cp .env.example .env.local
npm run dev
