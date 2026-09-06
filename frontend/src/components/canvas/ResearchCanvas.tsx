import { COMPETITORS } from "@/lib/mockData";

export default function ResearchCanvas() {
  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Interviews coded", value: "23" },
          { label: "Recurring pain", value: "11/23" },
          { label: "TAM (bottom-up)", value: "$4.8B" },
        ].map((m) => (
          <div key={m.label} className="bg-panel2 border border-border rounded-lg p-3">
            <div className="text-[11px] text-muted">{m.label}</div>
            <div className="text-lg font-semibold">{m.value}</div>
          </div>
        ))}
      </div>

      <div className="text-sm font-medium mb-2">
        Competitor matrix <span className="text-muted font-normal">· {COMPETITORS.length} tracked</span>
      </div>
      <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
        <thead className="bg-panel2 text-muted text-xs">
          <tr>
            <th className="text-left px-3 py-2">Product</th>
            <th className="text-left px-3 py-2">Segment</th>
            <th className="text-left px-3 py-2">Price</th>
            <th className="text-left px-3 py-2">Gap we exploit</th>
          </tr>
        </thead>
        <tbody>
          {COMPETITORS.map((c) => (
            <tr key={c.name} className="border-t border-border">
              <td className="px-3 py-2">{c.name}</td>
              <td className="px-3 py-2 text-muted">{c.segment}</td>
              <td className="px-3 py-2 text-muted">{c.price}</td>
              <td className="px-3 py-2 text-muted">{c.gap}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
