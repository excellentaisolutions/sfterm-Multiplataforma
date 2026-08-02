/** Logo SFTerm: tile titanium, prompt ❯ mostaza (#ff9101) y cursor plata.
 *  Mismo arte que el icono de la app (src-tauri/icons, generados desde
 *  assets/logo.svg). Cambiar el diseño = cambiar ambos. */
export default function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-label="SFTerm"
      style={{ display: "block", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="sft-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c1e24" />
          <stop offset="1" stopColor="#0c0d10" />
        </linearGradient>
      </defs>
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="15"
        fill="url(#sft-bg)"
        stroke="#2c2f37"
        strokeWidth="2"
      />
      <path
        d="M 19 21 L 31.5 32 L 19 43"
        fill="none"
        stroke="#ff9101"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="37" y="38.75" width="12.5" height="5.5" rx="2.2" fill="#e8e9ea" />
    </svg>
  );
}
