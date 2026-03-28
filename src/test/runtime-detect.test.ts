/**
 * Tests for runtime detection and image tag resolution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { detectRuntime, resolveImageTag } from '../sandbox/runtime-detect.js';
import type { TaskPayload } from '../types/index.js';

// ─── detectRuntime ───

describe('detectRuntime', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Rust from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "foo"');
    assert.equal(detectRuntime(tmpDir), 'rust');
  });

  it('detects Go from go.mod', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/foo');
    assert.equal(detectRuntime(tmpDir), 'go');
  });

  it('detects Ruby from Gemfile', () => {
    fs.writeFileSync(path.join(tmpDir, 'Gemfile'), 'source "https://rubygems.org"');
    assert.equal(detectRuntime(tmpDir), 'ruby');
  });

  it('detects JVM from pom.xml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
    assert.equal(detectRuntime(tmpDir), 'jvm');
  });

  it('detects JVM from build.gradle', () => {
    fs.writeFileSync(path.join(tmpDir, 'build.gradle'), 'plugins {}');
    assert.equal(detectRuntime(tmpDir), 'jvm');
  });

  it('detects Python from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "foo"');
    assert.equal(detectRuntime(tmpDir), 'python');
  });

  it('detects Python from requirements.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0');
    assert.equal(detectRuntime(tmpDir), 'python');
  });

  it('detects Python from setup.py', () => {
    fs.writeFileSync(path.join(tmpDir, 'setup.py'), 'from setuptools import setup');
    assert.equal(detectRuntime(tmpDir), 'python');
  });

  it('detects Node from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"foo"}');
    assert.equal(detectRuntime(tmpDir), 'node');
  });

  it('returns null for empty directory', () => {
    assert.equal(detectRuntime(tmpDir), null);
  });

  it('returns null for unrecognized files', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.c'), '#include <stdio.h>');
    assert.equal(detectRuntime(tmpDir), null);
  });

  it('Cargo.toml takes priority over package.json (Rust project with JS tooling)', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    assert.equal(detectRuntime(tmpDir), 'rust');
  });

  it('go.mod takes priority over requirements.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module foo');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask');
    assert.equal(detectRuntime(tmpDir), 'go');
  });
});

// ─── resolveImageTag ───

describe('resolveImageTag', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tier 1: image override takes highest priority', () => {
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      image: 'my-custom-image:v2',
      runtime: 'python',
      seedDir: tmpDir,
    };
    assert.equal(resolveImageTag(task), 'my-custom-image:v2');
  });

  it('tier 2: runtime field maps to crucible-runner:<runtime>', () => {
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      runtime: 'rust',
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:rust');
  });

  it('tier 3: detects runtime from seedDir', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]');
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      seedDir: tmpDir,
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:rust');
  });

  it('tier 3: detects runtime from inline files', () => {
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      files: {
        'go.mod': 'module example.com/foo',
        'main.go': 'package main',
      },
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:go');
  });

  it('tier 4: falls back to crucible-runner:base', () => {
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:base');
  });

  it('falls back to base when seedDir has no signature files', () => {
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      seedDir: tmpDir,
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:base');
  });

  it('runtime field wins over seedDir detection', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]');
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      runtime: 'python',
      seedDir: tmpDir,
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:python');
  });
});
