import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ROOT, type GraphState } from "@rcc/shared";
import { useGraphStore } from "../state/graphStore";
import { sendCommand } from "../net/connection";
import { visibleNodes, type Placement } from "../state/layout";

interface MindData extends Record<string, unknown> {
  title: string;
  summary?: string;
  depth: number;
  childCount: number;
  collapsed: boolean;
  sources: number;
  confidence?: number;
  onToggle?: () => void;
}

type MindFlowNode = Node<MindData, "mind">;

/** Hoisted so React Flow does not read every render as a new node type and remount the graph. */
const nodeTypes = { mind: MindNodeView };

export function MindMapView() {
  const graph = useGraphStore((s) => s.graph);
  const positions = useGraphStore((s) => s.positions);
  const collapsed = useGraphStore((s) => s.collapsed);
  const staleOpIds = useGraphStore((s) => s.staleOpIds);
  const snapshotStale = useGraphStore((s) => s.snapshotStale);
  const pinNode = useGraphStore((s) => s.pinNode);
  const toggleCollapsed = useGraphStore((s) => s.toggleCollapsed);

  const [nodes, setNodes, onNodesChange] = useNodesState<MindFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  /** The node under the pointer, if any. A batch arriving mid-drag must not move it back. */
  const draggingId = useRef<string | null>(null);

  const flow = useMemo(
    () => buildFlow(graph, positions, collapsed, toggleCollapsed),
    [graph, positions, collapsed, toggleCollapsed],
  );

  useEffect(() => {
    setNodes((current) => {
      const id = draggingId.current;
      // Only the dragged node's coordinates are carried over: everything else is the layout's to
      // restate, and `pinNode` has not run yet, so the store still holds the pre-drag position.
      const live = id ? current.find((node) => node.id === id) : undefined;
      if (!live) return flow.nodes;
      return flow.nodes.map((node) => (node.id === live.id ? { ...node, position: live.position } : node));
    });
  }, [flow.nodes, setNodes]);
  useEffect(() => setEdges(flow.edges), [flow.edges, setEdges]);

  const onNodeDragStart = useCallback<OnNodeDrag>((_event, node) => {
    draggingId.current = node.id;
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_event, node) => {
      draggingId.current = null;
      pinNode(node.id, node.position);
      // A drag is the only position the client's own layout cannot re-derive, so it is the only one
      // worth sending — it is what makes the arrangement survive a reload or a second tab.
      sendCommand({ cmd: "mindmap.node.moved", nodeId: node.id, x: node.position.x, y: node.position.y });
    },
    [pinNode],
  );

  return (
    <div className="mindmap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        fitView
        minZoom={0.25}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {staleOpIds.length > 0 && (
        <p className="mindmap__warning">
          {snapshotStale
            ? `服务端快照里有 ${staleOpIds.length} 个节点接不上父节点，它们在这一场里不会自己补齐。`
            : `${staleOpIds.length} 个操作因本地状态对不上被跳过，重连快照会自动补齐。`}
        </p>
      )}
    </div>
  );
}

function buildFlow(
  state: GraphState,
  positions: Record<string, Placement>,
  collapsed: Record<string, boolean>,
  toggleCollapsed: (id: string) => void,
): { nodes: MindFlowNode[]; edges: Edge[] } {
  const depth = new Map<string, number>();
  const measure = (key: string, level: number) => {
    for (const id of state.childOrder[key] ?? []) {
      depth.set(id, level);
      measure(id, level + 1);
    }
  };
  measure(ROOT, 0);

  const nodes: MindFlowNode[] = visibleNodes(state, collapsed).map((node) => {
    const childCount = (state.childOrder[node.id] ?? []).length;
    return {
      id: node.id,
      type: "mind",
      position: positions[node.id] ?? { x: 0, y: 0 },
      data: {
        title: node.title,
        ...(node.summary !== undefined ? { summary: node.summary } : {}),
        depth: depth.get(node.id) ?? 0,
        childCount,
        collapsed: collapsed[node.id] === true,
        sources: node.sourceTranscriptIds.length,
        ...(node.confidence !== undefined ? { confidence: node.confidence } : {}),
        ...(childCount > 0 ? { onToggle: () => toggleCollapsed(node.id) } : {}),
      },
    };
  });

  const treeEdges: Edge[] = nodes.flatMap((node) => {
    const parent = state.nodes[node.id]?.parentId;
    if (!parent) return [];
    return [{ id: `t-${parent}->${node.id}`, source: parent, target: node.id, type: "smoothstep" }];
  });

  // Relations the model added with `add_edge` are cross-links; the parent chain is already drawn.
  const visible = new Set(nodes.map((node) => node.id));
  const crossEdges: Edge[] = Object.values(state.edges)
    .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
    .filter((edge) => state.nodes[edge.target]?.parentId !== edge.source)
    .map((edge) => ({
      id: `x-${edge.id}`,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      style: { strokeDasharray: "4 4" },
      label: edge.relation,
    }));

  return { nodes, edges: [...treeEdges, ...crossEdges] };
}

function MindNodeView({ data }: NodeProps<MindFlowNode>) {
  return (
    <div className={`mind-node depth-${Math.min(data.depth, 3)}`}>
      <Handle type="target" position={Position.Left} />
      <div className="mind-node__head">
        <span className="mind-node__title">{data.title}</span>
        {data.childCount > 0 && (
          <button type="button" className="mind-node__toggle" onClick={data.onToggle} title={data.collapsed ? "展开" : "折叠"}>
            {data.collapsed ? `+${data.childCount}` : "−"}
          </button>
        )}
      </div>
      {data.summary && <p className="mind-node__summary">{data.summary}</p>}
      <div className="mind-node__meta">
        <span>{data.sources} 段依据</span>
        {data.confidence !== undefined && <span>{Math.round(data.confidence * 100)}%</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
