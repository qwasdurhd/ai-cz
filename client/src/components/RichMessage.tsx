import { useMemo, useState, type ReactNode } from "react";
import { Check, CheckCircle2, CircleX, Copy, Code2, Trophy } from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";

type QuizQuestion = { question: string; options: string[]; answer: number; explanation?: string };
type QuizPayload = { title?: string; description?: string; questions: QuizQuestion[] };

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function TokenizedCode({ code }: { code: string }) {
  const tokenRegex = /(\/\/.*|#.*)|(`[^`]*`|"[^"\n]*"|'[^'\n]*')|\b(const|let|var|function|return|if|else|for|while|import|from|export|class|def|async|await|try|catch|new|true|false|null|undefined|print|console)\b|(\b\d+(?:\.\d+)?\b)/g;
  return <>{code.split("\n").map((line, lineIndex) => <div className="code-line" key={`${lineIndex}-${line}`}><span className="code-line-number">{lineIndex + 1}</span><code>{(() => { const nodes: ReactNode[] = []; let last = 0; let match: RegExpExecArray | null; tokenRegex.lastIndex = 0; while ((match = tokenRegex.exec(line))) { if (match.index > last) nodes.push(escapeHtml(line.slice(last, match.index))); const token = escapeHtml(match[0]); const className = match[1] ? "tok-comment" : match[2] ? "tok-string" : match[3] ? "tok-keyword" : "tok-number"; nodes.push(<span className={className} key={`${lineIndex}-${match.index}`}>{token}</span>); last = match.index + match[0].length; } if (last < line.length) nodes.push(escapeHtml(line.slice(last))); return nodes; })()}</code></div>)}</>;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  return <div className="rich-code-block" dir="ltr"><div className="code-toolbar"><span><Code2 size={14} /> {language || "code"}</span><button onClick={copy}>{copied ? <><Check size={13} /> تم النسخ</> : <><Copy size={13} /> نسخ الكود</>}</button></div><pre><TokenizedCode code={code} /></pre></div>;
}

function MathBlock({ formula, inline = false }: { formula: string; inline?: boolean }) {
  const html = useMemo(() => katex.renderToString(formula.trim(), { displayMode: !inline, throwOnError: false, strict: "ignore" }), [formula, inline]);
  return <span className={inline ? "math-inline" : "math-block"} dir="ltr" dangerouslySetInnerHTML={{ __html: html }} />;
}

function parseQuiz(content: string): QuizPayload | null {
  const fenced = content.match(/```(?:quiz|quiz_json|json)\s*([\s\S]*?)```/i);
  const marker = content.match(/QUIZ_JSON\s*([\s\S]*)/i);
  const raw = fenced?.[1] || marker?.[1];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as QuizPayload;
    if (!Array.isArray(parsed.questions) || !parsed.questions.length) return null;
    const questions = parsed.questions.filter(item => Array.isArray(item.options) && item.options.length > 1 && Number.isInteger(item.answer)).map(item => ({ ...item, answer: Math.max(0, Math.min(item.answer, item.options.length - 1)) }));
    return questions.length ? { ...parsed, questions } : null;
  } catch {
    return null;
  }
}

function QuizCard({ quiz }: { quiz: QuizPayload }) {
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const score = quiz.questions.reduce((total, item, index) => total + (selected[index] === item.answer ? 1 : 0), 0);
  return <div className="quiz-card"><div className="quiz-card-head"><div className="quiz-icon"><Trophy size={17} /></div><div><b>{quiz.title || "اختبار تفاعلي"}</b><span>{quiz.description || `${quiz.questions.length} أسئلة — اختر الإجابة ثم اعرض النتيجة`}</span></div></div><div className="quiz-questions">{quiz.questions.map((item, index) => <div className="quiz-question" key={`${item.question}-${index}`}><div className="quiz-question-title"><span>{String(index + 1).padStart(2, "0")}</span><b>{item.question}</b></div><div className="quiz-options">{item.options.map((option, optionIndex) => { const isSelected = selected[index] === optionIndex; const isCorrect = submitted && optionIndex === item.answer; const isWrong = submitted && isSelected && !isCorrect; return <button className={`quiz-option ${isSelected ? "selected" : ""} ${isCorrect ? "correct" : ""} ${isWrong ? "wrong" : ""}`} key={option} onClick={() => !submitted && setSelected(prev => ({ ...prev, [index]: optionIndex }))}><span className="option-letter">{String.fromCharCode(65 + optionIndex)}</span><span>{option}</span>{isCorrect && <CheckCircle2 size={15} />}{isWrong && <CircleX size={15} />}</button>; })}</div>{submitted && item.explanation && <p className="quiz-explanation">{item.explanation}</p>}</div>)}</div><div className="quiz-footer">{submitted ? <div className="quiz-score"><span>نتيجتك</span><strong>{score} / {quiz.questions.length}</strong></div> : <span className="quiz-hint"><Check size={13} /> اختر إجابة لكل سؤال</span>}<button className={`quiz-submit ${submitted ? "again" : ""}`} disabled={!submitted && Object.keys(selected).length < quiz.questions.length} onClick={() => { if (submitted) { setSubmitted(false); setSelected({}); } else setSubmitted(true); }}>{submitted ? "إعادة المحاولة" : "تحقق من الإجابات"}</button></div></div>;
}

function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(\$[^$]+\$|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => part.startsWith("$") && part.endsWith("$") ? <MathBlock key={`${keyPrefix}-math-${index}`} formula={part.slice(1, -1)} inline /> : part.startsWith("**") && part.endsWith("**") ? <strong key={`${keyPrefix}-bold-${index}`}>{part.slice(2, -2)}</strong> : <span key={`${keyPrefix}-text-${index}`}>{part}</span>);
}

function RichText({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```|\$\$[\s\S]*?\$\$)/g).filter(part => part !== "");
  return <div className="rich-text">{parts.map((part, index) => { const code = part.match(/^```([^\n]*)\n([\s\S]*?)```$/); if (code) return <CodeBlock key={`code-${index}`} language={code[1].trim()} code={code[2].replace(/\n$/, "")} />; if (part.startsWith("$$") && part.endsWith("$$")) return <MathBlock key={`math-${index}`} formula={part.slice(2, -2)} />; return <div className="rich-copy" key={`copy-${index}`}>{part.split("\n").map((line, lineIndex) => <div className={line.startsWith("- ") ? "rich-bullet" : "rich-line"} key={`${index}-${lineIndex}`}>{line.startsWith("- ") ? <><span>•</span>{renderInline(line.slice(2), `${index}-${lineIndex}`)}</> : line ? renderInline(line, `${index}-${lineIndex}`) : <br />}</div>)}</div>; })}</div>;
}

export default function RichMessage({ content }: { content: string }) {
  const quiz = parseQuiz(content);
  if (quiz) return <QuizCard quiz={quiz} />;
  return <RichText content={content} />;
}
