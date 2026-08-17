const features = [
  {
    title: "Upload anything",
    description:
      "Drop in markdown, PDFs, or plain text. Cortex ingests and organizes your notes automatically.",
  },
  {
    title: "Semantic search",
    description:
      "Find ideas by meaning, not keywords. Every note becomes searchable the moment you upload it.",
  },
  {
    title: "Ask your notes",
    description:
      "Chat with your knowledge base. Get answers grounded in what you've actually written, with citations.",
  },
];

export function Features() {
  return (
    <section className="border-t border-border/60 bg-surface">
      <div className="mx-auto grid max-w-5xl gap-px px-6 py-24 sm:grid-cols-3">
        {features.map((feature) => (
          <div key={feature.title} className="px-4 py-2">
            <h3 className="text-sm font-semibold">{feature.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
