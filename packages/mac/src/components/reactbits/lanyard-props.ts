import type { CSSProperties, ComponentType } from 'react';
import Lanyard from './Lanyard.js';

/** Lanyard's props (Lanyard.tsx is React Bits' JavaScript, kept as published, so its types are here). */
export interface LanyardProps {
  /** Images (URLs) on the card's faces and along its strap. */
  readonly frontImage?: string;
  readonly backImage?: string;
  readonly strapImage?: string;
  readonly imageFit?: 'cover' | 'contain';
  readonly cardColor?: string;
  readonly orientation?: 'portrait' | 'landscape';
  readonly finish?: 'glossy' | 'matte' | 'holographic' | 'metallic';
  readonly cornerRadius?: number;
  readonly size?: number;
  readonly anchor?: 'left' | 'center' | 'right';
  readonly strapLength?: number;
  readonly strapColor?: string;
  readonly strapWidth?: number;
  readonly metal?: 'silver' | 'gold' | 'graphite';
  readonly gravity?: number;
  readonly damping?: number;
  readonly elasticity?: number;
  /** 0: it comes to rest (and stops drawing) once nobody moves it. */
  readonly breeze?: number;
  readonly interactive?: boolean;
  /** The canvas takes the pointer only over the card (it can then be bigger than its place). */
  readonly passThrough?: boolean;
  /** A new number gives the card a small wiggle by itself (0: never). */
  readonly wiggle?: number;
  readonly intro?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export default Lanyard as unknown as ComponentType<LanyardProps>;
