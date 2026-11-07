"""Measure motion between existing sprite poses without changing the PNGs."""

import base64
import argparse
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
RESOLUTION = 96
GRID_SIZE = 24
FLOW_SCALE = 1 / 4096
RIGID_FLOW_SCALE = 1 / 1536
MAX_DISPLACEMENT = 1.25 / 56
MAX_GRADIENT = .035


def resize_array(values, size):
    if values.ndim == 3:
        return np.stack([resize_array(values[:, :, channel], size)
                         for channel in range(values.shape[2])], axis=2)
    return np.asarray(Image.fromarray(values.astype(np.float32)).resize(
        (size, size), Image.Resampling.BILINEAR)).copy()


def warp(values, horizontal, vertical):
    height, width = horizontal.shape
    row, column = np.mgrid[:height, :width]
    x = np.clip(column + horizontal, 0, width - 1)
    y = np.clip(row + vertical, 0, height - 1)
    left = np.floor(x).astype(int)
    top = np.floor(y).astype(int)
    right = np.minimum(left + 1, width - 1)
    bottom = np.minimum(top + 1, height - 1)
    weight_x = (x - left)[:, :, None]
    weight_y = (y - top)[:, :, None]
    return (values[top, left] * (1 - weight_x) * (1 - weight_y)
            + values[top, right] * weight_x * (1 - weight_y)
            + values[bottom, left] * (1 - weight_x) * weight_y
            + values[bottom, right] * weight_x * weight_y)


def neighbor_average(values):
    padded = np.pad(values, 1, mode='edge')
    return (padded[:-2, 1:-1] + padded[2:, 1:-1]
            + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4


def gradient_bound(flow):
    horizontal = np.max(np.abs(np.diff(flow, axis=1) * GRID_SIZE), axis=(0, 1))
    vertical = np.max(np.abs(np.diff(flow, axis=0) * GRID_SIZE), axis=(0, 1))
    return float(np.sqrt(np.sum(horizontal ** 2 + vertical ** 2)))


def stabilize_flow(values, lock_height=False):
    flow = resize_array(values, GRID_SIZE)
    for _ in range(4):
        flow = np.stack([neighbor_average(flow[:, :, channel]) for channel in range(2)], axis=2)
    translation = np.median(flow[6:18, 6:18], axis=(0, 1))
    residual = flow - translation
    gradient = gradient_bound(residual)
    residual *= min(1, MAX_GRADIENT / max(gradient, 1e-9))
    flow = translation + residual
    magnitude = np.linalg.norm(flow, axis=2, keepdims=True)
    flow *= np.minimum(1, MAX_DISPLACEMENT / np.maximum(magnitude, 1e-9))
    if lock_height:
        height = (np.arange(GRID_SIZE) + .5) / GRID_SIZE
        upper = np.clip((height - .12) / .16, 0, 1)
        lower = np.clip((.90 - height) / .15, 0, 1)
        envelope = upper ** 2 * (3 - 2 * upper) * lower ** 2 * (3 - 2 * lower)
        flow[:, :, 1] *= envelope[:, None]
        flow *= min(1, MAX_GRADIENT / max(gradient_bound(flow), 1e-9))
    return flow


def pack_pair(forward, backward, scale=FLOW_SCALE):
    packed = np.concatenate([forward, backward], axis=2)
    packed = np.clip(np.rint(packed / scale + 128), 0, 255).astype(np.uint8)
    return base64.b64encode(packed.tobytes()).decode('ascii')


def encode_pair(forward, backward, lock_height=False, scale=FLOW_SCALE):
    return pack_pair(stabilize_flow(forward, lock_height), stabilize_flow(backward, lock_height), scale)


def encode_rigid_head_pair(first, second, forward, backward):
    size = first.shape[0]
    row, column = np.mgrid[:size, :size]
    coordinates = np.stack([(column + .5) / size, (row + .5) / size], axis=2)
    head = (((coordinates[:, :, 0] - .5) / .29) ** 2
            + ((coordinates[:, :, 1] - .28) / .24) ** 2) < 1
    gradient_y, gradient_x = np.gradient(first, axis=(0, 1))
    detail = .03 + np.sum(np.abs(gradient_x[:, :, :3]) + np.abs(gradient_y[:, :, :3]), axis=2)
    weights = first[:, :, 3] * detail * head
    total = max(float(weights.sum()), 1e-9)
    source_mean = np.sum(coordinates * weights[:, :, None], axis=(0, 1)) / total
    destination = coordinates + forward
    target_mean = np.sum(destination * weights[:, :, None], axis=(0, 1)) / total
    centered_source = (coordinates - source_mean).reshape(-1, 2)
    centered_target = (destination - target_mean).reshape(-1, 2)
    covariance = centered_source.T @ (centered_target * weights.reshape(-1, 1))
    left, _, right = np.linalg.svd(covariance)
    rotation = right.T @ left.T
    angle = float(np.clip(np.arctan2(rotation[1, 0], rotation[0, 0]), -.12, .12))
    cosine, sine = np.cos(angle), np.sin(angle)
    rotation = np.array([[cosine, -sine], [sine, cosine]])
    pivot = np.array([.5, .57])
    shift = target_mean - ((source_mean - pivot) @ rotation.T + pivot)
    shift *= min(1, (.9 / 56) / max(float(np.linalg.norm(shift)), 1e-9))
    measured = (coordinates - pivot) @ rotation.T + pivot + shift - coordinates
    moved = warp(second, measured[:, :, 0] * size, measured[:, :, 1] * size)
    original_error = float(np.sum(weights * np.mean((first - second) ** 2, axis=2)) / total)
    fitted_error = float(np.sum(weights * np.mean((first - moved) ** 2, axis=2)) / total)
    accepted = fitted_error < original_error * .96
    if not accepted:
        rotation = np.eye(2)
        shift = np.zeros(2)

    row, column = np.mgrid[:GRID_SIZE, :GRID_SIZE]
    grid = np.stack([(column + .5) / GRID_SIZE, (row + .5) / GRID_SIZE], axis=2)
    head_forward = (grid - pivot) @ rotation.T + pivot + shift - grid
    head_backward = (grid - pivot) @ rotation + pivot - shift @ rotation - grid
    vertical = np.clip((grid[:, :, 1] - .52) / .20, 0, 1)
    horizontal = np.minimum(np.clip((grid[:, :, 0] - .05) / .11, 0, 1),
                            np.clip((.95 - grid[:, :, 0]) / .11, 0, 1))
    mask = ((1 - vertical ** 2 * (3 - 2 * vertical)) * horizontal)[:, :, None]
    fields = []
    for raw, rigid in [(forward, head_forward), (backward, head_backward)]:
        magnitude = np.linalg.norm(rigid, axis=2, keepdims=True)
        rigid *= np.minimum(1, (3.5 / 56) / np.maximum(magnitude, 1e-9))
        fields.append(stabilize_flow(raw) * (1 - mask) + rigid * mask)
    return pack_pair(fields[0], fields[1], RIGID_FLOW_SCALE), accepted


def stabilize_existing(character):
    motion = character['motion']
    if motion.get('safetyVersion') == 1:
        return motion
    encoded = {}
    for key, value in motion['pairs'].items():
        packed = np.frombuffer(base64.b64decode(value), np.uint8).reshape(motion['grid'], motion['grid'], 4)
        vectors = (packed.astype(np.float32) - 128) * motion['scale']
        encoded[key] = encode_pair(vectors[:, :, :2], vectors[:, :, 2:])
    return {**motion, 'grid': GRID_SIZE, 'scale': FLOW_SCALE, 'pairs': encoded, 'safetyVersion': 1}


def optical_flow(first, second):
    horizontal = np.zeros((6, 6), dtype=np.float32)
    vertical = horizontal.copy()
    for size in [12, 24, 48, RESOLUTION]:
        factor = size / horizontal.shape[0]
        horizontal = resize_array(horizontal, size) * factor
        vertical = resize_array(vertical, size) * factor
        source = resize_array(first, size)
        destination = resize_array(second, size)
        gradient_y, gradient_x = np.gradient(destination, axis=(0, 1))
        for _ in range(24):
            moved = warp(destination, horizontal, vertical)
            derivative_x = warp(gradient_x, horizontal, vertical)
            derivative_y = warp(gradient_y, horizontal, vertical)
            average_x = neighbor_average(horizontal)
            average_y = neighbor_average(vertical)
            residual = (moved - source
                        + derivative_x * (average_x - horizontal)[:, :, None]
                        + derivative_y * (average_y - vertical)[:, :, None])
            denominator = .012 + np.sum(derivative_x ** 2 + derivative_y ** 2, axis=2)
            horizontal = average_x - np.sum(derivative_x * residual, axis=2) / denominator
            vertical = average_y - np.sum(derivative_y * residual, axis=2) / denominator
            horizontal = np.clip(horizontal, -size / 3, size / 3)
            vertical = np.clip(vertical, -size / 3, size / 3)
    return np.stack([horizontal, vertical], axis=2) / RESOLUTION


def build_character(character):
    stages = character['animations']
    lock_height = any(stage.get('scalesY') for stage in stages.values())
    rigid_head = character.get('motionProfile') == 'rigid-head-loop'
    encoding_scale = RIGID_FLOW_SCALE if rigid_head else FLOW_SCALE
    fitted_pairs = 0
    pictures = {}
    poses = {}

    def pose(phase, frame):
        key = (phase, frame)
        if key not in poses:
            stage = stages[phase]
            source = stage['src']
            if source not in pictures:
                pictures[source] = Image.open(ROOT / source).convert('RGBA')
            picture = pictures[source]
            width = picture.width / stage['columns']
            height = picture.height / stage['rows']
            origin_x = frame % stage['columns'] * width
            origin_y = frame // stage['columns'] * height
            offset_x, offset_y = stage.get('offsets', {}).get(str(frame), [0, 0])
            scale = stage.get('scale', 1)
            vertical_scale = stage.get('scalesY', {}).get(str(frame), scale)
            anchor_x, anchor_bottom = character.get('anchor', [.5, 0])
            anchor_y = 1 - anchor_bottom
            aligned = picture.transform((RESOLUTION, RESOLUTION), Image.Transform.AFFINE,
                (width / (RESOLUTION * scale), 0, origin_x + (anchor_x * (1 - 1 / scale) - offset_x) * width,
                 0, width / (RESOLUTION * vertical_scale), origin_y + (anchor_y * (1 - 1 / vertical_scale) + offset_y) * width),
                Image.Resampling.BICUBIC)
            pixels = np.asarray(aligned, dtype=np.float32) / 255
            alpha = pixels[:, :, 3:4]
            alpha = np.where(alpha < .03, 0, alpha)
            values = np.concatenate([pixels[:, :, :3] * alpha, alpha], axis=2)
            if stage.get('faceOffset'):
                height = (np.arange(RESOLUTION) + .5) / RESOLUTION
                upper = np.clip((height - .04) / .52, 0, 1)
                lower = np.clip((anchor_y - height) / (anchor_y - .56), 0, 1)
                weight = np.minimum(upper, lower)[:, None] * np.ones((1, RESOLUTION))
                horizontal = stage['faceOffset'][0] * weight * RESOLUTION
                vertical = stage['faceOffset'][1] * weight * RESOLUTION
                values = warp(values, horizontal, vertical)
            poses[key] = values
        return poses[key]

    pairs = set()
    for phase in ['enter', 'settle', 'loop', 'exit']:
        if phase not in stages:
            continue
        frames = stages[phase]['frames']
        pairs.update((phase, first, phase, second) for first, second in zip(frames, frames[1:]))
        if phase == 'loop':
            pairs.add((phase, frames[-1], phase, frames[0]))
    joins = [('enter', 'loop'), ('enter', 'exit'), ('exit', 'idle'), ('exit', 'enter')]
    if 'settle' in stages:
        joins.remove(('enter', 'loop'))
        joins.extend([('enter', 'settle'), ('settle', 'loop'), ('settle', 'exit')])
    for source_phase, target_phase in joins:
        pairs.add((source_phase, stages[source_phase]['frames'][-1],
                   target_phase, stages[target_phase]['frames'][0]))
    exit_poses = ([stages['loop'].get('exitFrame', stages['loop']['frames'][0])]
                  if stages['loop'].get('completeOnLeave') else stages['loop']['frames'])
    for frame in exit_poses:
        pairs.add(('loop', frame, 'exit', stages['exit']['frames'][0]))

    encoded = {}
    for source_phase, source_frame, target_phase, target_frame in sorted(pairs):
        source_stage = stages[source_phase]
        target_stage = stages[target_phase]
        if source_stage['src'] == target_stage['src'] and source_frame == target_frame:
            continue
        first = pose(source_phase, source_frame)
        second = pose(target_phase, target_frame)
        key = f'{source_phase}:{source_frame}>{target_phase}:{target_frame}'
        forward = optical_flow(first, second)
        backward = optical_flow(second, first)
        if rigid_head and source_phase == 'loop':
            encoded[key], accepted = encode_rigid_head_pair(first, second, forward, backward)
            fitted_pairs += int(accepted)
        else:
            encoded[key] = encode_pair(forward, backward, lock_height, encoding_scale)
    if rigid_head:
        print(f"{character['id']}: {fitted_pairs} head motions aligned without scaling", flush=True)
    result = {'grid': GRID_SIZE, 'scale': encoding_scale, 'pairs': encoded, 'safetyVersion': 1}
    if character['id'] == 'zai' and len(set(stages['loop']['frames'])) == 1:
        result['sleepSway'] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stabilize-existing', action='store_true')
    parser.add_argument('--character', action='append')
    arguments = parser.parse_args()
    manifest_path = ROOT / 'assets/companions.json'
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw.decode('utf-8'))
    known_ids = {character['id'] for character in manifest['characters']}
    if arguments.character and set(arguments.character) - known_ids:
        parser.error('Unknown character ID')
    for character in manifest['characters']:
        if arguments.character and character['id'] not in arguments.character:
            continue
        start = time.monotonic()
        character['motion'] = stabilize_existing(character) if arguments.stabilize_existing else build_character(character)
        print(f"{character['id']}: {len(character['motion']['pairs'])} motion pairs, "
              f'{time.monotonic() - start:.1f}s', flush=True)
    newline = '\r\n' if b'\r\n' in raw else '\n'
    output = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    manifest_path.write_bytes(output.replace('\n', newline).encode('utf-8'))


if __name__ == '__main__':
    main()
