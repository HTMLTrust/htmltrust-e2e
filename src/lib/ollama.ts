const TOPICS = [
  "the future of renewable energy", "urban gardening in small spaces",
  "remote work productivity tips", "the history of jazz music",
  "machine learning in healthcare", "sustainable fashion trends",
  "space exploration milestones", "the psychology of decision making",
  "electric vehicle adoption", "digital privacy and security",
  "the science of sleep", "modern architecture trends",
  "ocean conservation efforts", "the evolution of programming languages",
  "mindfulness and mental health",
];

export async function generateArticle(
  ollamaHost: string,
  model: string,
  opts: { authorName: string; index: number }
): Promise<{ title: string; content: string }> {
  const topic = TOPICS[opts.index % TOPICS.length];
  const prompt = `Write a short blog post (3-5 paragraphs) about ${topic}. Write only the article body, no title.`;

  const res = await fetch(`${ollamaHost}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama API failed: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as { response: string };
  const title = `${opts.authorName} on ${topic.charAt(0).toUpperCase() + topic.slice(1)}`;
  return { title, content: data.response };
}
