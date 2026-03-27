/**
 * GraphStore — Read/write DecompositionGraph as JSON files.
 *
 * Layout:
 *   runs/{runId}/
 *     graph.json            # DecompositionGraph
 *     nodes/{nodeId}.json   # Per-node detail
 *     events.jsonl          # Timestamped event stream
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DecompositionGraph, DecompositionNode, GraphEvent } from '../types/graph.js';

export class GraphStore {
  constructor(private readonly baseDir: string = 'runs') {}

  private runDir(runId: string): string {
    return path.join(this.baseDir, runId);
  }

  private graphPath(runId: string): string {
    return path.join(this.runDir(runId), 'graph.json');
  }

  private nodesDir(runId: string): string {
    return path.join(this.runDir(runId), 'nodes');
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), 'events.jsonl');
  }

  async saveGraph(graph: DecompositionGraph): Promise<void> {
    const dir = this.runDir(graph.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(this.nodesDir(graph.id), { recursive: true });
    await fs.writeFile(this.graphPath(graph.id), JSON.stringify(graph, null, 2), 'utf-8');

    // Write per-node detail files
    for (const node of graph.nodes) {
      await this.saveNodeDetail(graph.id, node.id, node);
    }
  }

  async loadGraph(runId: string): Promise<DecompositionGraph> {
    const content = await fs.readFile(this.graphPath(runId), 'utf-8');
    return JSON.parse(content) as DecompositionGraph;
  }

  async saveNodeDetail(runId: string, nodeId: string, detail: DecompositionNode): Promise<void> {
    const dir = this.nodesDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${nodeId}.json`);
    await fs.writeFile(filePath, JSON.stringify(detail, null, 2), 'utf-8');
  }

  async loadNodeDetail(runId: string, nodeId: string): Promise<DecompositionNode> {
    const filePath = path.join(this.nodesDir(runId), `${nodeId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as DecompositionNode;
  }

  async appendEvent(runId: string, event: GraphEvent): Promise<void> {
    const dir = this.runDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.eventsPath(runId), line, 'utf-8');
  }

  async loadEvents(runId: string): Promise<GraphEvent[]> {
    try {
      const content = await fs.readFile(this.eventsPath(runId), 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as GraphEvent);
    } catch {
      return [];
    }
  }

  async listGraphs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const ids: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            await fs.access(path.join(this.baseDir, entry.name, 'graph.json'));
            ids.push(entry.name);
          } catch {
            // No graph.json — skip
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  }
}
