export class MicBitratePolicy {
 reset(): void;
 observe(input: {nowMs:number;generation:number;path:string;eligible:boolean;congestedRejects:number;
 audioBacklogMs:number|null;queueAgeMs:number|null;mixPlayable:boolean|null}): {bitrate:number;reason:string};
 status(): {bitrate:number;reason:string};
}
