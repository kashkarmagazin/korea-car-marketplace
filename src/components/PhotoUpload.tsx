import { useState } from "react";
import { useApp } from "../lib/context";
import { AUTH } from "../lib/i18n";

const MAX = 12;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Rasmlarni 'car-photos' bucket'iga (uid/ papkasiga) yuklaydi va ochiq https havolalarni qaytaradi. */
export function PhotoUpload({ value, onChange }: { value: string[]; onChange: (urls: string[]) => void }) {
  const { sb, lang, session } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function add(files: FileList | null) {
    if (!files || !session) return;
    setErr("");
    setBusy(true);
    const urls = [...value];
    for (const f of Array.from(files).slice(0, MAX - value.length)) {
      if (!TYPES.includes(f.type) || f.size > 8 * 1024 * 1024) { setErr(AUTH.photos[lang]); continue; }
      const path = `${session.user.id}/${crypto.randomUUID()}.${f.type.split("/")[1]}`;
      const { error } = await sb.storage.from("car-photos").upload(path, f, { contentType: f.type });
      if (error) { setErr(error.message); continue; }
      urls.push(sb.storage.from("car-photos").getPublicUrl(path).data.publicUrl);
    }
    onChange(urls);
    setBusy(false);
  }

  return (
    <div>
      <label>{AUTH.photos[lang]}
        <input type="file" accept={TYPES.join(",")} multiple disabled={busy || value.length >= MAX} onChange={(e) => add(e.target.files)} />
      </label>
      {busy && <p className="muted">{AUTH.uploading[lang]}</p>}
      <div className="thumbs">
        {value.map((u) => (
          <span key={u} className="thumb">
            <img src={u} alt="" />
            <button type="button" onClick={() => onChange(value.filter((x) => x !== u))}>×</button>
          </span>
        ))}
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
