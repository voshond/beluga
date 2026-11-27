import { ChevronLeft, ChevronRight, Expand, ExternalLink, Footprints, Maximize2 } from 'lucide-react-native';
import { openFull } from '../../lib/fullscreen';
import { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from 'react-native-gesture-handler';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import Svg, { Defs, G, Marker, Path, Rect, Text as SvgText } from 'react-native-svg';
import { type ElkInput, type ElkOutput, type Graph, type GraphNode, KIND_ICON, KIND_NAME, STATUS_INFO, backEdges, connections, elkGraph, neighborhood, nodeBoxes, placeLabels, placesOf, roundedPath, routesOf, snapToGrid, stepFocus } from '../../lib/render';
import { color, elevation, spring, svgFont, type } from '../../lib/theme';
import { Sheet } from '../Sheet';
import { haptic, Pill, Press, T, type Tone, toneBg, toneInk } from '../ui';

/**
 * A `beluga-graph` on the phone (BLG-68; docs/graphs.md): laid out by ELK as the Mac lays it out
 * (the shared elkGraph request, src/shared/render/graph-model.ts), drawn with react-native-svg.
 * Pinch and pan to look around (double-tap Fit puts it back); tap a node for its details sheet
 * (what it is, its fields, links, and its lines in words); a walkthrough steps through with ‹ ›,
 * lighting up what each step names.
 */

const PHONE_FRAME = { width: 360, height: 440 };
const GRAPH_TONE: Record<string, Tone> = { muted: 'plain', claude: 'peach', info: 'sky', ok: 'mint', warn: 'butter', error: 'rose' };
const KIND_TONE: Partial<Record<string, Tone>> = { client: 'sky', service: 'lavender', database: 'butter', queue: 'peach', storage: 'butter', external: 'plain', actor: 'mint', person: 'mint', function: 'lavender', file: 'plain', decision: 'peach', note: 'butter', task: 'sky', milestone: 'mint', image: 'sky', metric: 'mint' };

type Elk = { layout(g: ElkInput): Promise<ElkOutput> };
let elk: Promise<Elk> | undefined;
const getElk = (): Promise<Elk> =>
  (elk ??= import('elkjs/lib/elk.bundled.js').then((m) => {
    const C = ((m as { default?: unknown }).default ?? m) as new () => Elk;
    // ELK's in-process worker (loaded inside `new C()`) checks "no `document` but a `self`" to decide it
    // is running in a web worker, and then exports nothing: React Native has exactly that, so the
    // constructor failed with "undefined cannot be used as a constructor". Hide `self` while it loads.
    const g = globalThis as { self?: unknown };
    const had = 'self' in g;
    const self = g.self;
    delete g.self;
    try {
      return new C();
    } finally {
      if (had) g.self = self;
    }
  }));

const sizeOf = (n: GraphNode) => ({ width: Math.round(Math.max(128, Math.min(210, Math.max(n.label.length, (n.sublabel ?? '').length * 0.85) * 7.2 + 52))), height: n.sublabel ? 58 : 46 });

interface Laid {
  readonly out: ElkOutput;
  readonly width: number;
  readonly height: number;
}

/** Lay it out both ways (as drawn, and turned) and keep the one that reads biggest on a phone. */
async function layoutFor(g: Graph): Promise<Laid> {
  const e = await getElk();
  const sizes = new Map(g.nodes.filter((n) => n.type !== 'group').map((n) => [n.id, sizeOf(n)]));
  const turned: Graph['direction'] = g.direction === 'right' || g.direction === 'left' ? 'down' : 'right';
  const tries = await Promise.all(([g.direction, turned] as const).map((d) => e.layout(JSON.parse(JSON.stringify(elkGraph(g, sizes, d))) as ElkInput).catch(() => undefined)));
  // On the grid, as on the Mac (snapToGrid).
  const laid = tries.flatMap((o, i) => (o ? [{ out: snapToGrid(o), preferred: i === 0 }] : [])).map((l) => ({ ...l, width: l.out.width ?? 300, height: l.out.height ?? 200 }));
  if (!laid.length) throw new Error('This graph couldn’t be laid out');
  const fit = (l: (typeof laid)[number]) => Math.min(1, PHONE_FRAME.width / l.width, PHONE_FRAME.height / l.height) * (l.preferred ? 1 : 0.9);
  return laid.sort((a, b) => fit(b) - fit(a))[0]!;
}

export function GraphCard({ graph, full }: { readonly graph: Graph; /** Full screen (BLG-71): taller, no Expand. */ readonly full?: boolean }) {
  const [laid, setLaid] = useState<Laid | undefined>();
  const [error, setError] = useState<string>();
  const [w, setW] = useState(0);
  const [open, setOpen] = useState<GraphNode | undefined>();
  const [step, setStep] = useState<number | undefined>();
  useEffect(() => {
    let alive = true;
    layoutFor(graph).then(
      (l) => alive && setLaid(l),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [graph]);

  const places = useMemo(() => (laid ? placesOf(laid.out) : undefined), [laid]);
  // Lines turned back for the layout point where they go again; labels find a free spot on their line.
  const routes = useMemo(() => (laid ? placeLabels(routesOf(laid.out, backEdges(graph)), new Map(graph.edges.flatMap((e) => (e.label ? [[e.id, e.label] as const] : []))), nodeBoxes(laid.out)) : undefined), [laid, graph]);
  // Absolute places (ELK's are relative to their group).
  const abs = useMemo(() => {
    if (!laid) return new Map<string, { x: number; y: number; width: number; height: number }>();
    const out = new Map<string, { x: number; y: number; width: number; height: number }>();
    const walk = (n: ElkOutput, ox: number, oy: number) => {
      for (const c of n.children ?? []) {
        const x = ox + (c.x ?? 0);
        const y = oy + (c.y ?? 0);
        out.set(c.id, { x, y, width: c.width ?? 0, height: c.height ?? 0 });
        walk(c, x, y);
      }
    };
    walk(laid.out, 0, 0);
    return out;
  }, [laid]);
  void places;
  void nodeBoxes;

  const focus = step !== undefined && graph.steps[step] ? stepFocus(graph, graph.steps[step]!) : open ? neighborhood(graph, open.id) : undefined;
  const fit = laid && w ? Math.min(1, (w - 16) / laid.width) : 1;
  const frameH = laid ? Math.min(full ? 900 : 440, Math.max(180, laid.height * fit + 16)) : 220;

  // Pinch and pan, on the UI thread; Fit puts it back.
  const scale = useSharedValue(1);
  const base = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const bx = useSharedValue(0);
  const by = useSharedValue(0);
  const pinch = usePinchGesture({
    onActivate: () => {
      'worklet';
      base.value = scale.value;
    },
    onUpdate: (e) => {
      'worklet';
      scale.value = Math.max(0.6, Math.min(4, base.value * e.scale));
    },
  });
  const pan = usePanGesture({
    minDistance: 6,
    onActivate: () => {
      'worklet';
      bx.value = tx.value;
      by.value = ty.value;
    },
    onUpdate: (e) => {
      'worklet';
      tx.value = bx.value + e.translationX;
      ty.value = by.value + e.translationY;
    },
  });
  const gestures = useSimultaneousGestures(pinch, pan);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));
  const reset = () => {
    scale.value = withSpring(1, spring.soft);
    tx.value = withSpring(0, spring.soft);
    ty.value = withSpring(0, spring.soft);
  };

  const dim = (on: boolean) => (focus && !on ? 0.22 : 1);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <View style={{ borderRadius: 16, backgroundColor: elevation.raised.surface, borderWidth: 1, borderColor: elevation.raised.border, overflow: 'hidden' }}>
      {graph.title || graph.summary ? (
        <View style={{ paddingHorizontal: 14, paddingTop: 12, gap: 2 }}>
          {graph.title ? <T v="heading" style={{ fontSize: 15.5 }}>{graph.title}</T> : null}
          {graph.summary ? <T v="caption">{graph.summary}</T> : null}
        </View>
      ) : null}
      <View onLayout={(e) => setW(Math.floor(e.nativeEvent.layout.width))} style={{ height: frameH, overflow: 'hidden' }}>
        {error ? (
          <T v="callout" c={color.error} style={{ padding: 14 }}>
            {error}
          </T>
        ) : !laid || !w ? (
          <T v="caption" style={{ padding: 14 }}>
            Drawing the graph…
          </T>
        ) : (
          <GestureDetector gesture={gestures}>
            <Animated.View entering={FadeIn.duration(240)} style={[{ width: laid.width * fit, height: laid.height * fit, margin: 8 }, moved]}>
              <Svg width={laid.width * fit} height={laid.height * fit} viewBox={`0 0 ${laid.width} ${laid.height}`}>
                <Defs>
                  <Marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                    <Path d="M0,0 L10,5 L0,10 z" fill={color.text3} />
                  </Marker>
                </Defs>
                {/* Groups first, as boxes behind their nodes. */}
                {graph.nodes
                  .filter((n) => n.type === 'group')
                  .map((n) => {
                    const p = abs.get(n.id);
                    if (!p) return null;
                    return (
                      <G key={n.id} opacity={dim(Boolean(focus?.nodes.has(n.id)))}>
                        <Rect x={p.x} y={p.y} width={p.width} height={p.height} rx={14} fill={color.sunken} stroke={color.hairlineStrong} strokeDasharray="5 4" />
                        <SvgText fontFamily={svgFont} x={p.x + 14} y={p.y + 22} fontSize={12} fontWeight="700" fill={color.text2}>
                          {n.label}
                        </SvgText>
                      </G>
                    );
                  })}
                {graph.edges.map((e) => {
                  const r = routes?.get(e.id);
                  if (!r) return null;
                  const on = Boolean(focus?.edges.has(e.id));
                  return (
                    <G key={e.id} opacity={dim(on)}>
                      <Path d={roundedPath(r.points)} fill="none" stroke={on || e.emphasis ? color.text2 : color.text3} strokeWidth={on || e.emphasis ? 2 : 1.4} strokeDasharray={e.kind === 'async' ? '6 4' : e.kind === 'depends' ? '2 4' : undefined} markerEnd="url(#arrow)" />
                      {e.label && r.label ? (
                        <G>
                          <Rect x={r.label.x - Math.min(110, e.label.length * 3.3 + 8)} y={r.label.y - 9} width={Math.min(220, e.label.length * 6.6 + 16)} height={18} rx={9} fill={color.card} stroke={color.hairline} />
                          <SvgText fontFamily={svgFont} x={r.label.x} y={r.label.y + 3.5} fontSize={10.5} fill={color.text2} textAnchor="middle">
                            {e.label}
                          </SvgText>
                        </G>
                      ) : null}
                    </G>
                  );
                })}
                {graph.nodes
                  .filter((n) => n.type !== 'group')
                  .map((n) => {
                    const p = abs.get(n.id);
                    if (!p) return null;
                    const tone: Tone = n.status ? (GRAPH_TONE[STATUS_INFO[n.status].tone] ?? 'plain') : (KIND_TONE[n.type] ?? 'plain');
                    const on = Boolean(focus?.nodes.has(n.id));
                    return (
                      <G key={n.id} opacity={dim(on)}>
                        <Rect x={p.x} y={p.y} width={p.width} height={p.height} rx={12} fill={color.card} stroke={on || n.emphasis ? toneInk(tone) : color.hairlineStrong} strokeWidth={on || n.emphasis ? 2 : 1} />
                        <Rect x={p.x + 10} y={p.y + p.height / 2 - 13} width={26} height={26} rx={8} fill={toneBg(tone === 'plain' ? 'sky' : tone)} />
                        <G transform={`translate(${p.x + 15}, ${p.y + p.height / 2 - 8})`}>
                          <Path d={KIND_ICON[n.type]} fill="none" stroke={toneInk(tone === 'plain' ? 'sky' : tone)} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                        </G>
                        <SvgText fontFamily={svgFont} x={p.x + 44} y={p.y + (n.sublabel ? p.height / 2 - 3 : p.height / 2 + 4.5)} fontSize={13} fontWeight="600" fill={color.text}>
                          {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
                        </SvgText>
                        {n.sublabel ? (
                          <SvgText fontFamily={svgFont} x={p.x + 44} y={p.y + p.height / 2 + 13} fontSize={10.5} fill={color.text3}>
                            {n.sublabel.length > 30 ? `${n.sublabel.slice(0, 29)}…` : n.sublabel}
                          </SvgText>
                        ) : null}
                      </G>
                    );
                  })}
              </Svg>
              {/* Taps on the nodes: a press over each (the same everywhere, unlike SVG's own presses). */}
              {graph.nodes
                .filter((n) => n.type !== 'group')
                .map((n) => {
                  const p = abs.get(n.id);
                  return p ? <Press key={n.id} haptics={false} scaleTo={0.96} accessibilityLabel={n.label} onPress={() => (haptic.tap(), setStep(undefined), setOpen(n))} style={{ position: 'absolute', left: p.x * fit, top: p.y * fit, width: p.width * fit, height: p.height * fit, borderRadius: 12 }} /> : null;
                })}
            </Animated.View>
          </GestureDetector>
        )}
        {laid ? (
          <Press onPress={reset} accessibilityLabel="Fit the graph" style={{ position: 'absolute', right: 8, top: 8, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card, borderWidth: 1, borderColor: color.hairline }}>
            <Maximize2 color={color.text2} size={14} />
          </Press>
        ) : null}
        {laid && !full ? (
          <Press onPress={() => openFull({ kind: 'graph', graph })} accessibilityLabel="Full screen" style={{ position: 'absolute', right: 44, top: 8, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card, borderWidth: 1, borderColor: color.hairline }}>
            <Expand color={color.text2} size={14} />
          </Press>
        ) : null}
      </View>
      {graph.steps.length ? <Steps graph={graph} step={step} setStep={(s) => (setOpen(undefined), setStep(s))} /> : null}
      <NodeSheet graph={graph} node={open} byId={byId} onClose={() => setOpen(undefined)} />
    </View>
  );
}

/** The walkthrough: one step at a time, what it names lit up. */
function Steps({ graph, step, setStep }: { readonly graph: Graph; readonly step: number | undefined; readonly setStep: (s: number | undefined) => void }) {
  const s = step !== undefined ? graph.steps[step] : undefined;
  const n = graph.steps.length;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: color.hairline, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Footprints color={color.text2} size={15} />
        <T v="callout" c={color.text} style={{ flex: 1, fontWeight: '700' }} numberOfLines={1}>
          {s ? s.title : `Walk through it · ${n} steps`}
        </T>
        {step !== undefined ? (
          <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
            {step + 1}/{n}
          </T>
        ) : null}
        <Press disabled={step === undefined} onPress={() => setStep(step! > 0 ? step! - 1 : undefined)} accessibilityLabel="Previous step" style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken, opacity: step === undefined ? 0.4 : 1 }}>
          <ChevronLeft color={color.text} size={16} />
        </Press>
        <Press disabled={step === n - 1} onPress={() => setStep(step === undefined ? 0 : step + 1)} accessibilityLabel="Next step" style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.primary, opacity: step === n - 1 ? 0.4 : 1 }}>
          <ChevronRight color={color.onPrimary} size={16} />
        </Press>
      </View>
      {s?.text ? (
        <Animated.View key={step} entering={FadeIn.duration(200)}>
          <T v="callout">{s.text}</T>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A node's details: what it is, its words, fields, links and lines. */
function NodeSheet({ graph, node, byId, onClose }: { readonly graph: Graph; readonly node?: GraphNode; readonly byId: ReadonlyMap<string, GraphNode>; readonly onClose: () => void }) {
  const [last, setLast] = useState(node);
  if (node && node !== last) setLast(node);
  const n = node ?? last;
  const lines = n ? connections(graph, n.id) : [];
  const st = n?.status ? STATUS_INFO[n.status] : undefined;
  return (
    <Sheet
      visible={!!node}
      onDismiss={onClose}
      window
      header={
        n ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 10, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T v="caption" style={{ flex: 1 }}>
                {KIND_NAME[n.type]}
                {n.group && byId.get(n.group) ? ` · in ${byId.get(n.group)!.label}` : ''}
              </T>
              {st ? <Pill label={st.label} tone={GRAPH_TONE[st.tone] ?? 'plain'} /> : null}
              {n.tag ? <Pill label={n.tag} /> : null}
            </View>
            <T v="title" style={{ fontSize: 21 }}>
              {n.label}
            </T>
            {n.sublabel ? <T v="callout">{n.sublabel}</T> : null}
          </View>
        ) : null
      }
    >
      {n ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 14 }}>
          {n.value ? <Text style={{ ...type.title, color: color.text }}>{n.value}</Text> : null}
          {n.details ? <T v="body">{n.details}</T> : null}
          {n.fields?.length ? (
            <View style={{ borderRadius: 12, backgroundColor: color.sunken, padding: 10, gap: 6 }}>
              {n.fields.map((f, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  {f.key ? <Pill label={f.key.toUpperCase()} tone={f.key === 'pk' ? 'butter' : 'sky'} style={{ height: 20, paddingHorizontal: 6 }} /> : null}
                  <Text style={[type.mono, { color: color.text, flex: 1 }]}>{f.name}</Text>
                  {f.type ? <Text style={[type.mono, { color: color.text3 }]}>{f.type}</Text> : null}
                </View>
              ))}
            </View>
          ) : null}
          {lines.length ? (
            <View style={{ gap: 8 }}>
              {lines.map((c) => (
                <View key={c.edge.id} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  <T v="callout">{c.verb}</T>
                  <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
                    {c.other.label}
                  </T>
                  {c.edge.label ? <T v="caption">· {c.edge.label}</T> : null}
                </View>
              ))}
            </View>
          ) : null}
          {n.links?.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {n.links
                .filter((l) => /^https?:\/\//.test(l.href))
                .map((l) => (
                  <Press key={l.href} onPress={() => void Linking.openURL(l.href)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: color.sunken }}>
                    <ExternalLink color={color.info} size={13} />
                    <T v="caption" c={color.info} style={{ fontWeight: '700' }}>
                      {l.label}
                    </T>
                  </Press>
                ))}
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </Sheet>
  );
}
