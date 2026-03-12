import { describe, expect, test } from "bun:test";
import { makeTransform, vec3, type Entity, type GeometryNode } from "@web-hammer/shared";
import { createGameplayRuntime } from "./runtime";
import { createMoverSystemDefinition, createOpenableSystemDefinition, createPathMoverSystemDefinition, createWaypointPath } from "./systems";

describe("gameplay runtime", () => {
  test("routes openable events through mover transforms", () => {
    const node: GeometryNode = {
      data: {},
      hooks: [
        {
          config: {
            initialState: "closed",
            mode: "slide"
          },
          id: "hook:openable",
          type: "openable"
        },
        {
          config: {
            duration: 0.5,
            kind: "lerp_transform",
            targets: {
              closed: {
                position: [0, 0, 0]
              },
              open: {
                position: [2, 0, 0]
              }
            }
          },
          id: "hook:mover",
          type: "mover"
        }
      ],
      id: "node:door",
      kind: "group",
      name: "Door",
      transform: makeTransform(vec3(0, 0, 0))
    };
    const scene = {
      entities: [] satisfies Entity[],
      nodes: [node]
    };
    const events: string[] = [];
    const runtime = createGameplayRuntime({
      systems: [createOpenableSystemDefinition(), createMoverSystemDefinition()],
      scene
    });

    runtime.onEvent((event) => {
      events.push(event.event);
    });
    runtime.start();
    runtime.emitEvent({
      event: "open.requested",
      sourceId: "test",
      sourceKind: "system",
      targetId: node.id
    });
    runtime.update(0.5);

    expect(runtime.getNodeWorldTransform(node.id)?.position.x).toBeCloseTo(2, 4);
    expect(events).toContain("open.started");
    expect(events).toContain("move.completed");
    expect(events).toContain("open.completed");
  });

  test("moves active path movers with consumer-provided paths", () => {
    const node: GeometryNode = {
      data: {},
      hooks: [
        {
          config: {
            active: true,
            loop: true,
            pathId: "sample:path",
            speed: 1
          },
          id: "hook:path",
          type: "path_mover"
        }
      ],
      id: "node:mover",
      kind: "group",
      name: "Mover",
      transform: makeTransform(vec3(0, 0, 0))
    };
    const runtime = createGameplayRuntime({
      systems: [
        createPathMoverSystemDefinition((target) =>
          target.targetId === node.id
            ? createWaypointPath([vec3(0, 0, 0), vec3(0, 0, 4)], true)
            : undefined
        )
      ],
      scene: {
        entities: [],
        nodes: [node]
      }
    });

    runtime.start();
    runtime.update(0.25);

    expect(runtime.getNodeWorldTransform(node.id)?.position.z).toBeCloseTo(1, 4);
  });

  test("processes queued micro-phases in order within a frame", () => {
    const node: GeometryNode = {
      data: {},
      hooks: [
        {
          config: {
            initialState: "closed",
            mode: "slide"
          },
          id: "hook:openable",
          type: "openable"
        }
      ],
      id: "node:test",
      kind: "group",
      name: "Test",
      transform: makeTransform(vec3(0, 0, 0))
    };
    const runtime = createGameplayRuntime({
      scene: {
        entities: [],
        nodes: [node]
      },
      systems: [createOpenableSystemDefinition()]
    });
    const events: string[] = [];

    runtime.onEvent((event) => {
      events.push(event.event);
    });
    runtime.start();
    runtime.emitEvent({
      event: "open.requested",
      sourceId: "test",
      sourceKind: "system",
      targetId: node.id
    });
    runtime.update(0);

    expect(events).toEqual(["open.requested", "open.started", "move.to"]);
  });
});
