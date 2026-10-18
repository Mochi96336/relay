export class MicBitratePolicy {
 /** The lowest step congestion may reach. */
 floor: number;
 reset(): void;
 observe(input: {nowMs:number;generation:number;path:string;eligible:boolean;congestedRejects:number;
 audioBacklogMs:number|null;queueAgeMs:number|null;mixPlayable:boolean|null}): {bitrate:number;reason:string};
 status(): {bitrate:number;reason:string};
}
