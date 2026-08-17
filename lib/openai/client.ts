import OpenAI from "openai";

// Make sure to set OPENAI_API_KEY in your .env.local
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy-key-for-tests",
});

export default openai;
