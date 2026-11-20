import { getObsCleanViewUrl } from './roomCode';

export interface ObsSceneCollection {
  current_scene: string;
  current_program_scene: string;
  scene_order: Array<{ name: string }>;
  name: string;
  sources: Array<Record<string, unknown>>;
  groups: unknown[];
  quick_transitions: Array<Record<string, unknown>>;
  transitions: unknown[];
  saved_projectors: unknown[];
  current_transition: string;
  transition_duration: number;
  preview_locked: boolean;
  scaling_enabled: boolean;
  scaling_level: number;
  scaling_off_x: number;
  scaling_off_y: number;
  modules: Record<string, unknown>;
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Dynamically generates a valid OBS Studio Scene Collection JSON file pre-configured
 * with a 1920x1080 Browser Source pointing to https://phonewebcam.pages.dev/?view=CODE
 * and `reroute_audio: true` ("Control audio via OBS") enabled.
 */
export function buildObsSceneCollection(roomCode: string): ObsSceneCollection {
  const cleanCode = roomCode.toUpperCase();
  const obsUrl = getObsCleanViewUrl(cleanCode);
  const sceneName = `PhoneWebcam (${cleanCode})`;
  const browserSourceName = `PhoneWebcam Feed (${cleanCode})`;
  const browserUuid = makeUuid();
  const sceneUuid = makeUuid();

  return {
    current_scene: sceneName,
    current_program_scene: sceneName,
    scene_order: [{ name: sceneName }],
    name: `PhoneWebcam-${cleanCode}`,
    sources: [
      {
        prev_ver: 503316480,
        name: browserSourceName,
        uuid: browserUuid,
        id: 'browser_source',
        versioned_id: 'browser_source',
        settings: {
          url: obsUrl,
          width: 1920,
          height: 1080,
          fps_custom: true,
          fps: 30,
          reroute_audio: true,
          restart_when_active: false,
          shutdown: false,
          webpage_control_level: 1,
          css: 'body { background-color: #000000; margin: 0 auto; overflow: hidden; }',
        },
        mixers: 255,
        sync: 0,
        flags: 0,
        volume: 1.0,
        balance: 0.5,
        enabled: true,
        muted: false,
        'push-to-mute': false,
        'push-to-mute-delay': 0,
        'push-to-talk': false,
        'push-to-talk-delay': 0,
        hotkeys: {},
        deinterlace_mode: 0,
        deinterlace_field_order: 0,
        monitoring_type: 0,
        private_settings: {},
      },
      {
        prev_ver: 503316480,
        name: sceneName,
        uuid: sceneUuid,
        id: 'scene',
        versioned_id: 'scene',
        settings: {
          id_counter: 1,
          custom_size: false,
          items: [
            {
              name: browserSourceName,
              source_uuid: browserUuid,
              visible: true,
              locked: false,
              rot: 0.0,
              scale_ref: { x: 1920.0, y: 1080.0 },
              align: 5,
              bounds_type: 2,
              bounds_align: 0,
              bounds_crop: false,
              crop_left: 0,
              crop_top: 0,
              crop_right: 0,
              crop_bottom: 0,
              id: 1,
              group_item_backup: false,
              pos: { x: 0.0, y: 0.0 },
              pos_rel: { x: -1.7777777910232544, y: -1.0 },
              scale: { x: 1.0, y: 1.0 },
              scale_rel: { x: 1.0, y: 1.0 },
              bounds: { x: 1920.0, y: 1080.0 },
              bounds_rel: { x: 3.555555582046509, y: 2.0 },
              scale_filter: 'disable',
              blend_method: 'default',
              blend_type: 'normal',
              show_transition: { duration: 0 },
              hide_transition: { duration: 0 },
              private_settings: {},
            },
          ],
        },
        mixers: 0,
        sync: 0,
        flags: 0,
        volume: 1.0,
        balance: 0.5,
        enabled: true,
        muted: false,
        'push-to-mute': false,
        'push-to-mute-delay': 0,
        'push-to-talk': false,
        'push-to-talk-delay': 0,
        hotkeys: {},
        deinterlace_mode: 0,
        deinterlace_field_order: 0,
        monitoring_type: 0,
        private_settings: {},
      },
    ],
    groups: [],
    quick_transitions: [
      {
        name: 'Cut',
        duration: 300,
        hotkeys: [],
        id: 1,
        fade_to_black: false,
      },
      {
        name: 'Fade',
        duration: 300,
        hotkeys: [],
        id: 2,
        fade_to_black: false,
      },
    ],
    transitions: [],
    saved_projectors: [],
    current_transition: 'Fade',
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0.0,
    scaling_off_y: 0.0,
    modules: {
      'scripts-tool': [],
      'output-timer': {
        streamTimerHours: 0,
        streamTimerMinutes: 0,
        streamTimerSeconds: 30,
        recordTimerHours: 0,
        recordTimerMinutes: 0,
        recordTimerSeconds: 30,
        autoStartStreamTimer: false,
        autoStartRecordTimer: false,
        pauseRecordTimer: true,
      },
      'auto-scene-switcher': {
        interval: 300,
        non_matching_scene: '',
        switch_if_not_matching: false,
        active: false,
        switches: [],
      },
    },
  };
}

/**
 * Triggers a client-side file download of the generated OBS Scene Collection .json.
 */
export function downloadObsSceneCollection(roomCode: string): void {
  const cleanCode = roomCode.toUpperCase();
  const payload = buildObsSceneCollection(cleanCode);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `PhoneWebcam-OBS-${cleanCode}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
