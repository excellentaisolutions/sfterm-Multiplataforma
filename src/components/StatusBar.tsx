import { useStore } from "../core/store";

export default function StatusBar() {
  const git = useStore((s) => s.git);
  const metrics = useStore((s) => s.metrics);
  const presetName = useStore((s) => s.presetName);
  const panels = useStore((s) => s.panels);
  const treeRoot = useStore((s) => s.treeRoot);

  const count = Object.keys(panels).length;
  const rootName = treeRoot.split("/").filter(Boolean).pop() ?? "";

  return (
    <div id="statusbar">
      {git?.is_repo ? (
        <span className="seg" title={`${rootName}: branch + cambios (espejo, solo lectura)`}>
          <span className="branch">⎇ {git.branch}</span>
          <span>{git.changed > 0 ? `${git.changed} cambios` : "limpio"}</span>
        </span>
      ) : (
        <span className="seg">{rootName}</span>
      )}
      {presetName && <span className="seg">· preset {presetName}</span>}
      <span className="spacer" />
      <span className="seg">{count} term{count === 1 ? "" : "s"}</span>
      <span
        className="seg ram"
        title={`App: ${metrics.appRam.toFixed(0)} MB · Workload (shells+agentes): ${metrics.workloadRam.toFixed(0)} MB`}
      >
        {metrics.appRam.toFixed(0)} MB · {metrics.appCpu.toFixed(0)}%
      </span>
    </div>
  );
}
