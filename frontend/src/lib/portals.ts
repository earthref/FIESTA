/** EarthRef portal registry rendered in the fixed top portal bar. */
export interface Portal {
  label: string;
  url: string;
  color: string;
}

export const PORTALS: Portal[] = [
  { label: "EarthRef.org", url: "https://earthref.org/", color: "#006600" },
  { label: "MagIC", url: "https://earthref.org/MagIC", color: "#800080" },
  { label: "KdD", url: "https://earthref.org/KdD", color: "#217e5c" },
  { label: "CDR", url: "https://earthref.org/CDR", color: "#e09f00" },
  { label: "KArAr", url: "https://earthref.org/KArAr", color: "#3030bb" },
  { label: "OSU-MGR", url: "https://osu-mgr.org", color: "#D73F09" },
  { label: "GERM", url: "https://earthref.org/GERM/", color: "#bb4b1c" },
  { label: "SBN", url: "https://earthref.org/SBN/", color: "#005b87" },
  { label: "FeMO", url: "https://earthref.org/FeMO/", color: "#9f0202" },
  { label: "SCC", url: "https://earthref.org/SCC/", color: "#8b216a" },
  { label: "ERESE", url: "https://earthref.org/ERESE/", color: "#3030bb" },
  { label: "ERDA", url: "https://earthref.org/ERDA/", color: "#006600" },
  { label: "References", url: "https://earthref.org/ERR/", color: "#006600" },
  { label: "Users", url: "https://earthref.org/ERML/", color: "#006600" },
];
