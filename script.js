const API_URL="/api/weather";
const state={rows:[],selectedCity:"",selectedTown:"",selectedDate:"",routeDate:"",forecastDates:[],defaultLocations:[],suggestionItems:[],suggestionIndex:-1};
const DEFAULT_KEY="weatherDefaultLocations";
const SEARCH_HISTORY_KEY="rideskySearchHistoryV1";
let cartoBasemapKey=(window.__CARTO_CONFIG__&&window.__CARTO_CONFIG__.key)||"";
let routeLoadingTimer=null;
function loadCartoBasemapKey(){
  if(!cartoBasemapKey)throw new Error("CARTO_API_KEY 尚未設定。");
  return cartoBasemapKey;
}

const $=s=>document.querySelector(s);

function icon(t=""){if(t.includes("雷"))return"⛈️";if(t.includes("雨"))return"🌧️";if(t.includes("雪"))return"❄️";if(t.includes("霧"))return"🌫️";if(t.includes("晴時多雲"))return"🌤️";if(t.includes("晴"))return"☀️";if(t.includes("多雲"))return"⛅";if(t.includes("陰"))return"☁️";return"🌈"}
function num(v){if(v==null||v===""||v==="--"||v==="無資料")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function windArrow(direction=""){const d=String(direction);if(d.includes("北北東")||d.includes("東北"))return"↗️";if(d.includes("東南")||d.includes("南東"))return"↘️";if(d.includes("南西")||d.includes("西南"))return"↙️";if(d.includes("西北")||d.includes("北西"))return"↖️";if(d.includes("東"))return"➡️";if(d.includes("南"))return"⬇️";if(d.includes("西"))return"⬅️";if(d.includes("北"))return"⬆️";return"🧭"}

function parseRows(data){
  // SQLite API 回傳的是扁平化的 Locations rows；
  // 舊版 CWA API 則是「縣市 -> Location -> WeatherElement」巢狀格式。
  if(data?.source==="SQLite"){
    const records=data?.records?.Locations||[];
    const groups=new Map();
    for(const r of records){
      const key=(r?.city||"未知縣市")+"||"+(r?.town||"未知鄉鎮");
      if(!groups.has(key)){
        groups.set(key,{
          city:r?.city||"未知縣市",
          town:r?.town||"未知鄉鎮",
          latitude:num(r?.latitude),
          longitude:num(r?.longitude),
          forecast:[]
        });
      }
      groups.get(key).forecast.push({
        city:r?.city||"未知縣市",
        town:r?.town||"未知鄉鎮",
        latitude:num(r?.latitude),
        longitude:num(r?.longitude),
        temperature:num(r?.temperature),
        humidity:num(r?.humidity),
        pop:num(r?.pop),
        windDirection:r?.wind_direction??"--",
        windSpeed:num(r?.wind_speed),
        weather:r?.weather??"資料待更新",
        start:r?.forecast_time||""
      });
    }
    return [...groups.values()].map(g=>{
      g.forecast.sort((a,b)=>new Date(a.start)-new Date(b.start));
      const now=Date.now();
      const current=g.forecast.reduce((best,r)=>{
        if(!best)return r;
        return Math.abs(new Date(r.start)-now)<Math.abs(new Date(best.start)-now)?r:best;
      },g.forecast[0]||null);
      const row=current||{
        city:g.city,town:g.town,latitude:g.latitude,longitude:g.longitude,
        temperature:null,humidity:null,pop:null,windDirection:"--",windSpeed:null,weather:"資料待更新",start:""
      };
      row.forecast=g.forecast;
      row.city=g.city; row.town=g.town; row.latitude=g.latitude; row.longitude=g.longitude;
      const riding=ridingCondition(row);
      return {...row,riding};
    });
  }
  // 保留舊版 CWA 原始資料格式解析能力。
  const groups=data?.records?.Locations||[],rows=[];
  for(const group of groups){
    const city=group?.LocationsName||"未知縣市";
    for(const l of group?.Location||[]){
      const es=l?.WeatherElement||[];
      const find=(...names)=>es.find(x=>names.includes(x.ElementName));
      const temperatureEl=find("溫度","Temperature");
      const humidityEl=find("相對濕度","RelativeHumidity");
      const popEl=find("3小時降雨機率","3小時降雨機率（%）","降雨機率","ProbabilityOfPrecipitation","3-hour ProbabilityOfPrecipitation");
      const windDirectionEl=find("風向","WindDirection");
      const windSpeedEl=find("風速","WindSpeed");
      const weatherEl=find("天氣現象","Weather");
      const timeKeys=new Set([
        ...(temperatureEl?.Time||[]).map(t=>t.StartTime||t.DataTime).filter(Boolean),
        ...(weatherEl?.Time||[]).map(t=>t.StartTime||t.DataTime).filter(Boolean)
      ]);
      const valueAt=(element,key)=>{
        const item=(element?.Time||[]).find(t=>(t.StartTime||t.DataTime)===key);
        return item?.ElementValue?.[0]||{};
      };
      const valueFrom=(v,names)=>{
        for(const name of names){
          if(v?.[name]!=null)return v[name];
        }
        return Object.values(v||{})[0];
      };
      const times=new Map();
      for(const key of timeKeys){
        const tv=valueAt(temperatureEl,key),hv=valueAt(humidityEl,key),pv=valueAt(popEl,key),wv=valueAt(windDirectionEl,key),ws=valueAt(windSpeedEl,key),xv=valueAt(weatherEl,key);
        const r={
          city,town:l?.LocationName||"未知鄉鎮",latitude:num(l?.Latitude),longitude:num(l?.Longitude),
          temperature:num(valueFrom(tv,["溫度","Temperature"])),
          humidity:num(valueFrom(hv,["相對濕度","RelativeHumidity"])),
          pop:num(valueFrom(pv,["ProbabilityOfPrecipitation","3小時降雨機率","3小時降雨機率（%）"])),
          windDirection:valueFrom(wv,["風向","WindDirection"])??"--",
          windSpeed:num(valueFrom(ws,["風速","WindSpeed"])),
          weather:valueFrom(xv,["天氣現象","Weather"])??"資料待更新",
          start:key
        };
        times.set(key,r);
      }
      const forecast=[...times.values()].sort((a,b)=>new Date(a.start)-new Date(b.start));
      const current=forecast[0]||{
        city,town:l?.LocationName||"未知鄉鎮",latitude:num(l?.Latitude),longitude:num(l?.Longitude),
        temperature:null,humidity:null,pop:null,windDirection:"--",windSpeed:null,weather:"資料待更新",start:""
      };
      current.forecast=forecast;
      rows.push(current);
    }
  }
  return rows.map(r=>{
    const riding=ridingCondition(r);
    return {...r,riding};
  });
}
function buildDecisionSupport(r){
  const riding=r?.riding||ridingCondition(r);
  const reasons=riding.reasons||[];
  let action="EXECUTE";
  let actionLabel="可出發";
  let actionIcon="🟢";
  if(riding.level==="high"){
    action="WAIT"; actionLabel="建議等待"; actionIcon="🔴";
  }else if(riding.level==="caution"){
    action="ASK"; actionLabel="出發前再次確認"; actionIcon="🟠";
  }else if(riding.level==="normal"){
    action="ASK"; actionLabel="建議確認天氣"; actionIcon="🟡";
  }
  const evidence=[
    Number.isFinite(r.temperature)?("溫度 "+fmt(r.temperature," °C")):null,
    Number.isFinite(r.humidity)?("濕度 "+fmt(r.humidity," %")):null,
    Number.isFinite(r.pop)?("降雨機率 "+fmt(r.pop," %")):"降雨機率：資料缺失",
    Number.isFinite(r.windSpeed)?("風速 "+fmt(r.windSpeed," m/s")):"風速：資料缺失"
  ].filter(Boolean);
  return {
    action,actionLabel,actionIcon,score:riding.score,reasons,evidence,
    advice:riding.advice,rainGear:riding.rainGear,rainRisk:riding.rainRisk
  };
}

function ridingAdvice(condition){
  const reasons=condition?.reasons||[];
  const level=condition?.level;
  const temperatureAlert=condition?.temperatureAlert||"";
  const addTemperatureAlert=message=>temperatureAlert?temperatureAlert+" "+message:message;
  if(condition?.rainGear==="強烈建議攜帶"){
    return addTemperatureAlert("降雨風險較高，建議攜帶雨具並在出發前再次確認最新天氣。");
  }
  if(level==="high"){
    return addTemperatureAlert("目前騎乘條件較不利，出發前請重新確認最新天氣資訊，並留意降雨與風勢。");
  }
  if(level==="caution"){
    if(reasons.some(x=>x.includes("降雨")||x.includes("陣雨")||x.includes("雷雨")||x.includes("大雨")||x.includes("豪雨"))){
      return addTemperatureAlert("騎乘時需留意降雨，建議攜帶雨具並持續確認天氣變化。");
    }
    if(reasons.includes("風速強")||reasons.includes("風速偏強")||reasons.includes("風速較高")){
      return addTemperatureAlert("騎乘時需留意風勢，經過橋梁、開闊路段時請特別注意。");
    }
    return addTemperatureAlert("目前騎乘條件需注意，建議出發前再次確認天氣與路況。");
  }
  if(level==="normal"){
    return condition?.rainGear==="建議攜帶"
      ? addTemperatureAlert("整體騎乘條件尚可，但有降雨可能，建議攜帶雨具並持續留意天氣。")
      : addTemperatureAlert("整體騎乘條件尚可，仍建議持續留意降雨與風勢變化。");
  }
  return condition?.rainGear==="建議攜帶"
    ? addTemperatureAlert("目前騎乘條件穩定，但仍有降雨可能，建議攜帶雨具。")
    : addTemperatureAlert("目前天氣條件較穩定，適合一般騎乘；出發前仍可確認最新天氣資訊。");
}

function classifyRainRisk(pop,weather){
  const text=String(weather||"").replaceAll("臺","台");
  let weatherLevel=0;
  if(/大豪雨|豪雨|強烈雷雨/.test(text))weatherLevel=4;
  else if(/雷雨|雷陣雨|大雨|強陣雨/.test(text))weatherLevel=3;
  else if(/短暫雨|短暫陣雨|午後.*陣雨|陣雨|有雨|降雨|持續降雨/.test(text))weatherLevel=1;
  let popLevel=null;
  if(Number.isFinite(pop)){
    if(pop>=90)popLevel=4;
    else if(pop>=70)popLevel=3;
    else if(pop>=50)popLevel=2;
    else if(pop>=20)popLevel=1;
    else popLevel=0;
  }
  const riskLevel=Math.max(weatherLevel,popLevel==null?0:popLevel);
  const penalty=Math.min(4,riskLevel);
  let rainRisk="低";
  if(riskLevel>=4)rainRisk="極高";
  else if(riskLevel>=3)rainRisk="高";
  else if(riskLevel>=2)rainRisk="中高";
  else if(riskLevel>=1)rainRisk="中";
  let rainGear="不需特別準備";
  if(riskLevel>=4)rainGear="強烈建議攜帶";
  else if(riskLevel>=2)rainGear="建議攜帶";
  else if(riskLevel===1)rainGear=(weatherLevel>=1||popLevel>=1)?"建議攜帶":"可考慮攜帶";
  return {riskLevel,penalty,rainRisk,rainGear,weatherLevel,popLevel};
}

function ridingCondition(r){
  const temp=num(r?.temperature);
  const humidity=num(r?.humidity);
  const wind=num(r?.windSpeed);
  const pop=num(r?.pop);
  const weather=String(r?.weather||"");
  let score=5;
  const reasons=[];
  const missing=[];

  const rain=classifyRainRisk(pop,weather);
  if(rain.penalty>0){
    if(rain.popLevel>=4)reasons.push("降雨機率極高");
    else if(rain.popLevel===3)reasons.push("降雨機率高");
    else if(rain.popLevel===2)reasons.push("降雨機率偏高");
    else if(rain.popLevel===1)reasons.push("有降雨可能");
    if(rain.weatherLevel>=4)reasons.push("嚴重降雨");
    else if(rain.weatherLevel===3)reasons.push("雷雨或強降雨");
    else if(rain.weatherLevel===1 && !/晴時多雲|多雲/.test(weather))reasons.push("可能出現陣雨");
  }
  if(!Number.isFinite(pop))missing.push("降雨機率資料缺失");

  let windPenalty=0;
  if(Number.isFinite(wind)){
    if(wind>=13){windPenalty=4;reasons.push("強風");}
    else if(wind>=10){windPenalty=3;reasons.push("風速強");}
    else if(wind>=7){windPenalty=2;reasons.push("風速偏強");}
    else if(wind>=5){windPenalty=1;reasons.push("風速較高");}
  }else{
    missing.push("風速資料缺失");
  }

  // 溫度不列入騎乘適合度評分，僅作為獨立提醒。
  let tempPenalty=0;
  let temperatureAlert="";
  if(Number.isFinite(temp)){
    if(temp>=35)temperatureAlert="🌡️ 高溫提醒：目前氣溫偏高，長時間騎乘請注意補充水分、防曬與適度休息。";
    else if(temp>=33)temperatureAlert="🌡️ 高溫提醒：目前氣溫偏高，騎乘時請注意補充水分與防曬。";
    else if(temp<=10)temperatureAlert="🥶 低溫提醒：目前氣溫偏低，騎乘時請注意保暖，並留意長時間曝露於低溫環境。";
    else if(temp<15)temperatureAlert="🥶 低溫提醒：目前氣溫偏低，騎乘時請注意保暖。";
  }else{
    missing.push("溫度資料缺失");
  }

  let humidityPenalty=0;
  if(Number.isFinite(humidity)){
    if(humidity>=90){humidityPenalty=1;reasons.push("濕度高");}
    else if(humidity>=85){humidityPenalty=1;reasons.push("濕度偏高");}
  }else{
    missing.push("濕度資料缺失");
  }

  const availableFactors=[temp,humidity,wind,pop].filter(Number.isFinite).length;
  if(missing.length)reasons.push("部分氣象資料缺失，評分僅依目前可用資料估算");

  const incomplete=availableFactors===0;
  if(incomplete){
    return {
      score:null,level:"normal",label:"資料不足",icon:"🟡",
      reasons:reasons.length?reasons:["目前沒有可用的騎乘評估資料"],
      missing,incomplete:true,weatherRisk:false,rainRisk:rain.rainRisk,rainGear:rain.rainGear,
      rainPenalty:rain.penalty,advice:"目前缺少可用的氣象資料，暫時無法估算騎乘條件。"
    };
  }

  score-=rain.penalty+windPenalty+tempPenalty+humidityPenalty;

  // 主要不利因素同時出現時，避免單項扣分不足以反映整體騎乘環境。
  const majorFactors=[
    rain.riskLevel>=1,
    windPenalty>=1
  ].filter(Boolean).length;
  if(majorFactors>=3){
    score=Math.min(score,2);
    reasons.push("多項主要不利因素同時存在");
  }else if(majorFactors>=2){
    score=Math.min(score,3);
    reasons.push("同時存在多項不利因素");
  }

  // 嚴重降雨／雷雨設定最高分，避免其他舒適條件抵銷明顯的降雨風險。
  if(rain.weatherLevel>=4)score=Math.min(score,1);
  else if(rain.weatherLevel===3)score=Math.min(score,2);
  else if(rain.weatherLevel===1)score=Math.min(score,4);

  score=Math.max(0,Math.min(5,score));

  let level="good",label="良好",icon="🟢";
  if(score<=1){level="high";label="高風險";icon="🔴";}
  else if(score===2){level="caution";label="需注意";icon="🟠";}
  else if(score===3){level="normal";label="普通";icon="🟡";}

  const condition={
    score,level,label,icon,reasons,missing,incomplete:false,
    weatherRisk:rain.riskLevel>=2,rainRisk:rain.rainRisk,rainGear:rain.rainGear,
    rainPenalty:rain.penalty,temperatureAlert
  };
  condition.advice=missing.length
    ? "目前以已取得的氣象資料估算騎乘條件；部分資料缺失，結果可能存在誤差。"
    : ridingAdvice(condition);
  return condition;
}
function ridingLevel(score){
  if(score<=1)return {level:"high",label:"高風險",icon:"🔴"};
  if(score===2)return {level:"caution",label:"需注意",icon:"🟠"};
  if(score===3)return {level:"normal",label:"普通",icon:"🟡"};
  return {level:"good",label:"良好",icon:"🟢"};
}

function fmt(v,s=""){return v==null?"--":(Number.isInteger(v)?v:v.toFixed(1))+s}
function taiwanDateKey(value){
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return "";
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
}
function todayTaiwan(){
  return taiwanDateKey(new Date());
}
function availableForecastDates(){
  if(state.forecastDates.length)return state.forecastDates.slice(0,7);
  const set=new Set();
  state.rows.forEach(r=>(r.forecast||[]).forEach(item=>{
    const key=taiwanDateKey(item.start);
    if(key)set.add(key);
  }));
  state.forecastDates=[...set].sort().slice(0,7);
  return state.forecastDates;
}
function formatForecastDate(key){
  if(!key)return "";
  const d=new Date(key+"T00:00:00+08:00");
  if(Number.isNaN(d.getTime()))return key;
  const month=String(d.getMonth()+1).padStart(2,"0");
  const day=String(d.getDate()).padStart(2,"0");
  const weekday=["日","一","二","三","四","五","六"][d.getDay()];
  return month+"/"+day+" (週"+weekday+")";
}
function formatTaiwanDateTime(value){
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime()))return "--";
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);
  const get=t=>parts.find(p=>p.type===t)?.value||"00";
  return get("year")+"/"+get("month")+"/"+get("day")+" "+get("hour")+":"+get("minute")+":"+get("second");
}
function rowForDate(r,dateKey=state.selectedDate){
  if(!r)return null;
  const items=(r.forecast||[]).filter(x=>taiwanDateKey(x.start)===dateKey);
  if(!items.length)return null;
  const target=new Date(dateKey+"T12:00:00+08:00").getTime();
  return items.slice().sort((a,b)=>Math.abs(new Date(a.start).getTime()-target)-Math.abs(new Date(b.start).getTime()-target))[0]||items[0];
}
function selectedRows(rows=state.rows){
  const dateKey=state.selectedDate||todayTaiwan();
  return rows.map(r=>rowForDate(r,dateKey)).filter(Boolean).map(x=>{
    const base=state.rows.find(r=>r.city===x.city&&r.town===x.town)||x;
    return {...x,forecast:base.forecast||x.forecast};
  });
}
function populateForecastDateSelect(){
  const sel=$("#forecastDateSelect");
  if(!sel)return;
  const dates=availableForecastDates();
  const today=todayTaiwan();
  state.selectedDate=dates.includes(state.selectedDate)?state.selectedDate:(dates.includes(today)?today:(dates[0]||""));
  sel.innerHTML=dates.map(key=>'<option value="'+key+'">'+formatForecastDate(key)+'</option>').join("");
  sel.value=state.selectedDate;
}
function refreshSelectedDateView(){
  const rows=selectedRows();
  if(state.selectedCity&&state.selectedTown){
    const r=rows.find(x=>x.city===state.selectedCity&&x.town===state.selectedTown);
    if(r)renderRows([r],false);
    else renderDefaultCards();
  }else if(state.selectedCity){
    renderCityCards(state.selectedCity);
  }else{
    renderDefaultCards();
  }
  lazyLoadTaiwanMap();
}
function cities(){return [...new Set(state.rows.map(r=>r.city))]}
function towns(city){return state.rows.filter(r=>r.city===city).sort((a,b)=>a.town.localeCompare(b.town,"zh-Hant"))}
function cityRepresentative(city){const rs=towns(city);return rs[0]||null}
function routeOptionValue(r){return r.city+"||"+r.town}
function routeDateValue(){const dates=availableForecastDates();if(!dates.length)return todayTaiwan();if(!state.routeDate||!dates.includes(state.routeDate))state.routeDate=dates.includes(todayTaiwan())?todayTaiwan():dates[0];return state.routeDate;}
function routeWeatherRow(r){return rowForDate(r,routeDateValue())||r;}
function findRouteRow(value){const [city,town]=String(value||"").split("||");const base=state.rows.find(r=>r.city===city&&r.town===town)||null;return base?routeWeatherRow(base):null;}
function populateRouteDateSelect(){const sel=$("#routeDateSelect");if(!sel)return;const dates=availableForecastDates();state.routeDate=dates.includes(state.routeDate)?state.routeDate:(dates.includes(todayTaiwan())?todayTaiwan():(dates[0]||""));sel.innerHTML=dates.map(key=>'<option value="'+key+'">'+formatForecastDate(key)+(key===todayTaiwan()?" · 今天":"")+'</option>').join("");sel.value=state.routeDate;}
function populateRouteSelects(){
  const options=state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)).slice().sort((a,b)=>(a.city+a.town).localeCompare(b.city+b.town,"zh-Hant"));
  const html='<option value="">請選擇地點</option>'+options.map(r=>'<option value="'+routeOptionValue(r).replaceAll('"','&quot;')+'">'+r.city+"｜"+r.town+"</option>").join("");
  ["#routeFrom","#routeTo"].forEach(sel=>{const el=$(sel);if(el)el.innerHTML=html;});
  setupRouteSearch("from"); setupRouteSearch("to");
}
function routeSearchElements(side){
  const cap=side==="from"?"From":"To";
  return {input:$("#route"+cap+"Search"),suggestions:$("#route"+cap+"Suggestions"),townWrap:$("#route"+cap+"TownWrap"),town:$("#route"+cap+"Town"),value:$("#route"+cap)};
}
function populateRouteTown(side,city,selected=""){
  const el=routeSearchElements(side).town;
  el.innerHTML='<option value="">請選擇鄉鎮</option>';
  towns(city).filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)).forEach(r=>{const o=document.createElement("option");o.value=routeOptionValue(r);o.textContent=r.town;if(r.town===selected)o.selected=true;el.appendChild(o);});
}
function focusNextRouteField(side){
  setTimeout(()=>{
    if(side==="from"){
      const next=$("#routeToSearch");
      if(next)next.focus();
    }else{
      const button=$("#analyzeRouteBtn");
      if(button)button.focus();
    }
  },0);
}
function focusRouteTown(side){
  setTimeout(()=>{
    const town=routeSearchElements(side).town;
    if(town)town.focus();
  },0);
}
function setRouteLocation(side,r){
  const e=routeSearchElements(side); if(!r)return;
  e.value.value=routeOptionValue(r); e.input.value=r.town;
  e.townWrap.classList.add("hidden"); e.suggestions.classList.add("hidden");
  focusNextRouteField(side);
}
function renderRouteSuggestions(side){
  const e=routeSearchElements(side),q=normalizeSearchText(e.input.value);
  e.suggestions.innerHTML="";
  if(!q){e.suggestions.classList.add("hidden");e.townWrap.classList.add("hidden");return;}
  const cityMatches=cities().filter(c=>normalizeSearchText(c).includes(q));
  const townMatches=state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&normalizeSearchText(r.town).includes(q));
  const exactCity=cities().find(c=>normalizeSearchText(c)===q);
  if(exactCity){
    e.suggestions.classList.add("hidden");e.townWrap.classList.remove("hidden");populateRouteTown(side,exactCity);
    e.input.dataset.city=exactCity;e.input.dataset.mode="city";e.value.value="";
    focusRouteTown(side);
    return;
  }
  const items=[],seen=new Set();
  cityMatches.forEach(city=>{if(!seen.has(city)){seen.add(city);items.push({type:"city",city,town:"",name:city,label:"縣市"});}});
  townMatches.forEach(r=>items.push({type:"town",city:r.city,town:r.town,name:r.town,label:"鄉鎮"}));
  items.slice(0,10).forEach(m=>{const b=document.createElement("button");b.type="button";b.className="suggestion";b.innerHTML="<span>"+m.name+"</span><small>"+m.label+(m.type==="town"?"｜"+m.city:"")+"</small>";b.addEventListener("click",()=>selectRouteSearch(side,m));e.suggestions.appendChild(b);});
  e.suggestions.classList.toggle("hidden",!items.length);
  e.townWrap.classList.add("hidden");
}
function selectRouteSearch(side,m){
  const e=routeSearchElements(side); e.input.dataset.city=m.city;
  if(m.type==="town"){const r=findRouteRow(routeOptionValue({city:m.city,town:m.town}));setRouteLocation(side,r);return;}
  e.input.value=m.city;e.input.dataset.mode="city";e.value.value="";populateRouteTown(side,m.city);e.townWrap.classList.remove("hidden");e.suggestions.classList.add("hidden");
  focusRouteTown(side);
}
function setupRouteSearch(side){
  const e=routeSearchElements(side); if(!e.input||e.input.dataset.ready)return;
  e.input.dataset.ready="1";
  e.input.dataset.index="-1";
  e.input.addEventListener("input",()=>{e.input.dataset.index="-1";renderRouteSuggestions(side);});
  e.input.addEventListener("keydown",e2=>handleRouteSearchKeydown(side,e2));
  e.town.addEventListener("keydown",e2=>{
    if(e2.key==="Enter"&&e2.target.value){
      const r=findRouteRow(e2.target.value);
      if(r){setRouteLocation(side,r);e2.preventDefault();}
    }
  });
  e.town.addEventListener("change",()=>{const r=findRouteRow(e.town.value);if(r)setRouteLocation(side,r);});
}
function routeSuggestionButtons(side){
  return [...routeSearchElements(side).suggestions.querySelectorAll(".suggestion")];
}
function setRouteSuggestionIndex(side,index){
  const e=routeSearchElements(side),buttons=routeSuggestionButtons(side);
  if(!buttons.length)return;
  const next=Math.max(0,Math.min(index,buttons.length-1));
  e.input.dataset.index=String(next);
  buttons.forEach((el,i)=>el.classList.toggle("active",i===next));
  buttons[next]?.scrollIntoView({block:"nearest"});
}
function handleRouteSearchKeydown(side,event){
  const e=routeSearchElements(side),box=e.suggestions;
  if(event.key==="Escape"){
    box.classList.add("hidden");
    e.input.dataset.index="-1";
    return;
  }
  const buttons=routeSuggestionButtons(side);
  if(box.classList.contains("hidden")||!buttons.length){
    if((event.key==="ArrowDown"||event.key==="ArrowUp")&&e.input.value){
      renderRouteSuggestions(side);
      event.preventDefault();
      setRouteSuggestionIndex(side,event.key==="ArrowDown"?0:routeSuggestionButtons(side).length-1);
    }
    return;
  }
  const current=Number(e.input.dataset.index||"-1");
  if(event.key==="ArrowDown"){
    event.preventDefault();
    setRouteSuggestionIndex(side,current<0?0:current+1);
  }else if(event.key==="ArrowUp"){
    event.preventDefault();
    setRouteSuggestionIndex(side,current<0?buttons.length-1:current-1);
  }else if(event.key==="Enter"){
    event.preventDefault();
    const index=current<0?0:current;
    const items=buttons[index];
    if(items)items.click();
  }
}

function routeStepText(step){
  return [step?.ref,step?.name,step?.destinations,step?.exits].filter(Boolean).join(" ");
}
/*
 * 路線「道路可達性」分組。
 *
 * 重要：縣市相同 ≠ 一定存在道路連線。
 * 例如：
 *   澎湖縣七美鄉 ↔ 澎湖縣馬公市：中間是海，必須搭船／飛機，不能算道路路線。
 *   連江縣南竿鄉 ↔ 北竿鄉：必須搭船／飛機，不能算道路路線。
 *
 * 因此這裡不再用「縣市」當作唯一的 routing guard，而是用「實際道路島群」。
 * 只有同一個道路島群才允許進入 OSRM / Valhalla。
 */
const ROUTE_ISLAND_GROUPS=Object.freeze({
  main:"台灣本島",
  kinmen:"金門本島＋烈嶼（已有金門大橋道路連線）",
  penghuMain:"澎湖本島道路群（馬公／湖西／白沙／西嶼）",
  penghuWangan:"澎湖－望安島",
  penghuQimei:"澎湖－七美島",
  taitungMain:"台東本島",
  taitungGreen:"台東－綠島",
  taitungLanyu:"台東－蘭嶼",
  lienchiangNangan:"馬祖－南竿",
  lienchiangBeigan:"馬祖－北竿",
  lienchiangDongyin:"馬祖－東引",
  lienchiangJuguang:"馬祖－莒光"
});
const ROUTE_ISLAND_COUNTIES=Object.freeze({
  kinmen:"金門縣",
  penghu:"澎湖縣",
  lienchiang:"連江縣",
  taitung:"台東縣"
});

function routeIslandGroup(row){
  if(!row||!row.city)return "main";
  const city=String(row.city).replaceAll("臺","台");
  const town=String(row.town||"").replaceAll("臺","台");

  // 金門本島與烈嶼已由金門大橋形成道路連線，因此視為同一道路島群。
  if(city==="金門縣")return "kinmen";

  // 澎湖：馬公、湖西、白沙、西嶼屬可由道路／橋梁連接的道路群；
  // 望安、七美是不同島嶼，兩者到馬公都需要海空交通。
  if(city==="澎湖縣"){
    if(town==="七美鄉")return "penghuQimei";
    if(town==="望安鄉")return "penghuWangan";
    return "penghuMain";
  }

  // 台東縣：台東市、成功、池上、關山、鹿野、太麻里等台灣本島地區
  // 與其他本島縣市屬於同一條道路島群；只有綠島、蘭嶼是獨立離島道路群。
  if(city==="台東縣"){
    if(town==="綠島鄉")return "taitungGreen";
    if(town==="蘭嶼鄉")return "taitungLanyu";
    return "main";
  }

  // 連江縣：四個行政鄉並不是同一道路網。
  // 南竿、北竿、東引、莒光之間都必須透過海空交通。
  if(city==="連江縣"){
    if(town==="南竿鄉")return "lienchiangNangan";
    if(town==="北竿鄉")return "lienchiangBeigan";
    if(town==="東引鄉")return "lienchiangDongyin";
    if(town==="莒光鄉")return "lienchiangJuguang";
    return "lienchiangNangan";
  }

  return "main";
}
function routeRegionPolicy(from,to){
  const a=routeIslandGroup(from),b=routeIslandGroup(to);
  if(a===b){
    return {allowed:true,group:a,label:ROUTE_ISLAND_GROUPS[a]};
  }

  const aCity=String(from?.city||"").replaceAll("臺","台");
  const bCity=String(to?.city||"").replaceAll("臺","台");
  const sameCounty=aCity===bCity;

  return {
    allowed:false,
    group:a,
    label:"不可跨道路島群連線",
    message:sameCounty
      ? aCity+"內的這兩個地區沒有純道路連線，必須搭乘船舶或飛機；RideSky 不會把海運／空運當成道路路線。"
      : "起點與終點不在同一道路島群，兩地之間沒有純道路連線；RideSky 不會把海運／空運當成道路路線。"
  };
}
function routeRegionReminder(from,to){
  const p=routeRegionPolicy(from,to);
  if(p.allowed){
    if(p.group==="main")return "🛣️ 台灣本島道路路線";
    return "🏝️ "+p.label+"：僅分析島群內道路";
  }
  return "🚢 "+p.message;
}
const RIDESKY_FIXED_ROUTE_ORIGINS={
  "基隆市||七堵區":{
    name:"七堵車站",
    address:"基隆市七堵區長興里東新街2號",
    latitude:25.09294,
    longitude:121.71415,
    source:"七堵車站公開座標資料"
  }
};
function isQiduRow(row){
  return String(row?.city||"").replaceAll("臺","台")==="基隆市" &&
    String(row?.town||"").replaceAll("臺","台")==="七堵區";
}
function fixedRouteOrigin(row){
  if(!isQiduRow(row))return null;
  const p=RIDESKY_FIXED_ROUTE_ORIGINS["基隆市||七堵區"];
  return {
    latitude:p.latitude,
    longitude:p.longitude,
    city:row.city,
    town:row.town,
    fixedOriginName:p.name,
    fixedOriginAddress:p.address
  };
}
function routeLocationObject(row){
  return fixedRouteOrigin(row)||{
    latitude:Number(row.latitude),longitude:Number(row.longitude),city:row.city,town:row.town
  };
}
function routeHasForbiddenNationalMain(route){
  const steps=(route?.legs||[]).flatMap(leg=>leg?.steps||[]);
  const nationalPattern=/國道\s*(1|2|3|4|5|6|7|8|9|10)\s*(號|線)?/;
  return steps.some(step=>{
    const text=routeStepText(step).replaceAll("臺","台");
    if(/國道\s*甲/.test(text))return false;
    if(nationalPattern.test(text))return true;
    if(/(?:中山高速公路|福爾摩沙高速公路|北二高|二高|蔣渭水高速公路|北宜高速公路|水沙連高速公路|高速公路)/.test(text))return true;
    if(step?.road_classification?.motorway_class===true)return true;
    const ref=String(step?.ref||"").replaceAll("臺","台").trim();
    if(/^國道\s*(1|2|3|4|5|6|7|8|9|10)\s*(號|線)?$/.test(ref))return true;
    return false;
  });
}
function routePolicyLabel(route){
  const nationalBlocked=routeHasForbiddenNationalMain(route);
  return nationalBlocked
    ? "⚠️ 路線仍包含國道主線"
    : "🚫 已啟用：避開國道主線（國道甲線保留）";
}
function haversineKm(a,b){
  const R=6371;
  const p1=a[0]*Math.PI/180,p2=b[0]*Math.PI/180;
  const dp=(b[0]-a[0])*Math.PI/180,dl=(b[1]-a[1])*Math.PI/180;
  const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

/*
 * 路線合理性檢查：
 * OSRM / Valhalla 在「多錨點 + 避開高速公路」的搜尋下，偶爾可能回傳
 * 極端繞行的合法 geometry。這種結果不能被當成最佳路線。
 * 以起終點直線距離建立寬鬆上限；一般台灣道路繞行不應接近 2.4 倍，
 * 同時設定 650 km 絕對上限，避免跨區搜尋出現數百公里以上的異常繞行。
 */
function routeLooksPlausible(route,from,to){
  const distance=Number(route?.distance);
  if(!Number.isFinite(distance)||distance<=0)return false;
  const coords=route?.geometry?.coordinates||[];
  if(coords.length<2)return false;
  const start=coords[0],end=coords[coords.length-1];
  const directKm=haversineKm([Number(from.latitude),Number(from.longitude)],[Number(to.latitude),Number(to.longitude)]);
  if(!Number.isFinite(directKm)||directKm<=0)return false;
  const routeKm=distance/1000;
  const maxByRatio=Math.max(120,directKm*2.4);
  const maxKm=Math.min(650,maxByRatio);
  return routeKm<=maxKm;
}
function routeLevel(score){return ridingLevel(score)}
function routeDecision(level){
  if(level==="high")return {icon:"🔴",label:"建議等待"};
  if(level==="caution")return {icon:"🟠",label:"出發前再次確認"};
  if(level==="normal")return {icon:"🟡",label:"建議確認天氣"};
  return {icon:"🟢",label:"可騎乘"};
}
function sampleRoutePoints(coords,count=30){
  if(!coords.length)return [];
  const n=Math.min(count,coords.length),out=[];
  if(n===1)return [coords[0]];
  for(let i=0;i<n;i++){
    const index=Math.round(i*(coords.length-1)/(n-1));
    out.push(coords[index]);
  }
  return out;
}
function routeDistanceToPointKm(point,coords){
  if(!Array.isArray(coords)||coords.length<2)return Infinity;
  let best=Infinity;
  const lat0=point[0]*Math.PI/180;
  const cosLat=Math.max(0.2,Math.cos(lat0));
  for(let i=1;i<coords.length;i++){
    const a=coords[i-1],b=coords[i];
    const ax=(a[1]-point[1])*cosLat,ay=a[0]-point[0];
    const bx=(b[1]-point[1])*cosLat,by=b[0]-point[0];
    const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy;
    const t=len2?Math.max(0,Math.min(1,-(ax*dx+ay*dy)/len2)):0;
    const x=ax+dx*t,y=ay+dy*t;
    const km=Math.sqrt(x*x+y*y)*111.32;
    if(km<best)best=km;
  }
  return best;
}
function routeAnalysisCoords(coords,maxPoints=900){
  if(!Array.isArray(coords)||coords.length<=maxPoints)return coords||[];
  const out=[];
  for(let i=0;i<maxPoints;i++){
    const index=Math.round(i*(coords.length-1)/(maxPoints-1));
    const p=coords[index];
    if(!out.length||p[0]!==out[out.length-1][0]||p[1]!==out[out.length-1][1])out.push(p);
  }
  return out;
}
function routeWeatherCoverage(coords){
  const corridorKm=6;
  const covered=[];
  // 完整 geometry 留給地圖繪製；氣象 corridor 分析最多使用約 900 個折線點。
  // 可大幅降低「368 個鄉鎮 × 數千/數萬道路節點 × 多候選」造成的 UI blocking。
  const analysisCoords=routeAnalysisCoords(coords,900);
  for(const row of state.rows){
    if(!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude))continue;
    const distance=routeDistanceToPointKm([row.latitude,row.longitude],analysisCoords);
    if(distance<=corridorKm){
      const condition=row.riding||ridingCondition(row);
      covered.push({row:routeWeatherRow(row),distance,condition});
    }
  }
  return covered.sort((a,b)=>a.distance-b.distance);
}
function nearestWeatherRow(lat,lon){
  let best=null,bestDistance=Infinity;
  for(const r of state.rows){
    if(!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))continue;
    const d=haversineKm([lat,lon],[r.latitude,r.longitude]);
    if(d<bestDistance){bestDistance=d;best=r;}
  }
  return best?{row:best,distance:bestDistance}:null;
}
function routeClass(level){return level==="high"?"route-high":level==="caution"?"route-caution":level==="normal"?"route-normal":"route-good"}

function routeCandidateAnalysis(route){
  const coords=(route?.geometry?.coordinates||[]).map(p=>[p[1],p[0]]);
  const nearby=[];const seen=new Set();const samples=sampleRoutePoints(coords,60);
  samples.forEach((p,index)=>{
    const hit=nearestWeatherRow(p[0],p[1]);
    if(hit){
      const weatherRow=routeWeatherRow(hit.row),key=weatherRow.city+"||"+weatherRow.town;
      if(!seen.has(key)){
        seen.add(key);
        nearby.push({...hit,row:weatherRow,routeSampleIndex:index,routeSampleCount:samples.length,isRouteInterior:index>0&&index<samples.length-1});
      }
    }
  });

  // 不再只依賴固定 30 個幾何採樣點。
  // 直接建立「道路中心線 ±6 km」的氣象走廊，避免路線實際經過蘇澳等鄉鎮，
  // 卻因採樣點剛好沒有落在代表座標附近而被漏掉。
  const corridor=routeWeatherCoverage(coords);
  corridor.forEach(item=>{
    const key=item.row.city+"||"+item.row.town;
    if(!seen.has(key)){
      seen.add(key);
      nearby.push({
        row:item.row,
        distance:item.distance,
        routeSampleIndex:-1,
        routeSampleCount:samples.length,
        isRouteInterior:item.distance<=6
      });
    }
  });

  const conditions=nearby.map(x=>x.row.riding||ridingCondition(x.row)).filter(c=>Number.isFinite(c.score));
  const interior=nearby.filter(x=>x.isRouteInterior);
  const interiorConditions=interior.map(x=>x.row.riding||ridingCondition(x.row)).filter(c=>Number.isFinite(c.score));
  const rainLevels=nearby.map(x=>(x.row.riding||ridingCondition(x.row)).rainPenalty||0);
  const pops=nearby.map(x=>x.row.pop).filter(Number.isFinite);
  const rainyInteriorPoints=interior.filter(x=>{
    const c=x.row.riding||ridingCondition(x.row);
    return Number.isFinite(c.rainPenalty)&&c.rainPenalty>0;
  });
  const badInteriorPoints=interior.filter(x=>{
    const c=x.row.riding||ridingCondition(x.row);
    return Number.isFinite(c.score)&&c.score<=3;
  });
  const severeInteriorPoints=interior.filter(x=>{
    const c=x.row.riding||ridingCondition(x.row);
    return Number.isFinite(c.score)&&c.score<=2;
  });
  return {route,coords,nearby,conditions,interiorConditions,badInteriorPoints,severeInteriorPoints,rainyInteriorPoints,
    hasBadInteriorPoints:badInteriorPoints.length>0,hasRainyInteriorPoints:rainyInteriorPoints.length>0,
    rainMetric:rainLevels.length?rainLevels.reduce((a,b)=>a+b,0)/rainLevels.length:0,
    maxPop:pops.length?Math.max(...pops):null,minScore:conditions.length?Math.min(...conditions.map(c=>c.score)):null,
    avgScore:conditions.length?conditions.reduce((a,c)=>a+c.score,0)/conditions.length:null};
}
function endpointRiskWarning(from,to){
  const warnings=[];
  [[from,"起點"],[to,"終點"]].forEach(([r,label])=>{
    const c=r?.riding||ridingCondition(r);
    if(Number.isFinite(c.score)&&c.score<=2)warnings.push({label,row:r,condition:c});
  });
  return warnings;
}
function loadRouteHistory(){try{const x=JSON.parse(localStorage.getItem(ROUTE_HISTORY_KEY)||"[]");return Array.isArray(x)?x.slice(0,10):[];}catch(_){return [];}}
function renderRouteHistory(){
  const box=$("#routeHistoryList");if(!box)return;const history=loadRouteHistory();
  if(!history.length){box.innerHTML='<div class="route-history-empty">尚無歷史路線查詢。</div>';return;}
  box.innerHTML=history.map((h,i)=>{const f=h.from||{},t=h.to||{},d=h.time?new Date(h.time):null;const tm=d&&!Number.isNaN(d.getTime())?formatTaiwanDateTime(d):"--";const dateLabel=h.date?formatForecastDate(h.date):"當日";return '<button type="button" class="route-history-item" data-history-index="'+i+'"><div><div class="route-history-route">'+(f.city||"--")+"｜"+(f.town||"--")+" → "+(t.city||"--")+"｜"+(t.town||"--")+'</div><span class="route-history-time">'+tm+'</span></div><span class="route-history-arrow">›</span></button>';}).join("");
  box.querySelectorAll(".route-history-item").forEach(btn=>btn.addEventListener("click",()=>{
    const h=history[Number(btn.dataset.historyIndex)];if(!h)return;
    if(h.date){state.routeDate=h.date;const ds=$("#routeDateSelect");if(ds)ds.value=h.date;}
    const f=findRouteRow((h.from?.city||"")+"||"+(h.from?.town||"")),t=findRouteRow((h.to?.city||"")+"||"+(h.to?.town||""));
    if(f)setRouteLocation("from",f);if(t)setRouteLocation("to",t);
    const details=btn.closest(".route-history-collapse");
    if(details)details.open=false;
  }));
}
function saveRouteHistoryItem(from,to){
  const date=routeDateValue();const key=from.city+"||"+from.town+"=>"+to.city+"||"+to.town+"=>"+date;
  const history=loadRouteHistory().filter(h=>(h.from?.city+"||"+h.from?.town+"=>"+h.to?.city+"||"+h.to?.town+"=>"+(h.date||todayTaiwan()))!==key);
  history.unshift({from:{city:from.city,town:from.town},to:{city:to.city,town:to.town},date,time:Date.now()});
  try{localStorage.setItem(ROUTE_HISTORY_KEY,JSON.stringify(history.slice(0,10)));}catch(_){}
  renderRouteHistory();
}
function routeEndpointPopupHTML(r,icon,label){
  const riding=r.riding||ridingCondition(r);
  return '<div class="weather-popup"><h4>'+r.city+"｜"+r.town+'</h4><div class="weather-temp">'+fmt(r.temperature," °C")+'</div><p>💧 濕度：'+fmt(r.humidity," %")+'</p><p>🌧️ 降雨機率：'+fmt(r.pop," %")+'</p><p>💨 風向：'+(r.windDirection||"--")+'</p><p>💨 風速：'+fmt(r.windSpeed," m/s")+'</p><p><strong>🏍️ 騎乘條件：'+(riding.icon||"")+" "+(riding.label||"--")+'</strong></p><p>評分：'+(Number.isFinite(riding.score)?riding.score:"--")+'</p><p>☔ 雨具建議：'+(riding.rainGear||"--")+'</p><p class="popup-muted">'+(riding.reasons?.length?"主要因素："+riding.reasons.join("、")+"<br>":"")+(riding.advice||"")+'</p></div>';
}
function renderRouteEndpoints(from,to){
  routeEndpointMarkers.forEach(m=>m.remove());routeEndpointMarkers=[];if(!taiwanMap)return;
  [[from,"📍","起點"],[to,"🏁","終點"]].forEach(([r,ico,label])=>{
    if(!r||!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))return;
    const c=r.riding||ridingCondition(r);
    const m=L.marker([r.latitude,r.longitude],{icon:L.divIcon({className:"route-endpoint-marker",html:"<span>"+ico+"</span>",iconSize:[36,36],iconAnchor:[18,18]}),zIndexOffset:1200}).addTo(taiwanMap);
    m.bindPopup(routeEndpointPopupHTML(r,ico,label));
    routeEndpointMarkers.push(m);
  });
}
function clearRouteEndpoints(){routeEndpointMarkers.forEach(m=>m.remove());routeEndpointMarkers=[];activeRouteEndpoints=null;}
function routeRainZoneRadiusKm(row){
  const c=row?.riding||ridingCondition(row);
  const pop=Number(row?.pop);
  const score=Number(c?.score);
  const weatherLevel=Number(c?.rainPenalty)||0;

  // 宣紙模式 hard exclusion：
  // Score 1 代表目前騎乘條件已屬高風險，不能只當成排序扣分。
  // 只要不是起終點本身，就把這類區域視為必須繞開的禁止走廊。
  // 半徑刻意大於一般降雨 buffer，避免像烏來這種範圍較大的山區只因代表座標偏離道路而漏判。
  if(Number.isFinite(score)&&score<=1)return Math.max(22,
    weatherLevel>=4||pop>=90?20:
    weatherLevel>=3||pop>=70?15:
    weatherLevel>=2||pop>=50?11:
    weatherLevel>=1||pop>=20?7:0
  );
  if(weatherLevel>=4||pop>=90)return 20;
  if(weatherLevel>=3||pop>=70)return 15;
  if(weatherLevel>=2||pop>=50)return 11;
  if(weatherLevel>=1||pop>=20)return 7;
  return 0;
}
function buildRainAvoidanceZones(analyses){
  const zones=[],seen=new Set();
  for(const a of analyses||[]){
    // 雨區 + Score 1 高風險區一併建立 hard exclusion zone。
    // 這可避免「有降雨但採樣漏掉」或「Score 已掉到 1，卻因 rainPenalty 判定方式不同而沒有建立雨區」。
    const items=[
      ...(a.rainyInteriorPoints||[]),
      ...(a.severeInteriorPoints||[]).filter(item=>{
        const row=item.row||item;
        const c=row?.riding||ridingCondition(row);
        return Number.isFinite(c?.score)&&c.score<=1;
      })
    ];
    for(const item of items){
      const row=item.row||item;
      if(!row||!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude))continue;
      const key=row.city+"||"+row.town;
      if(seen.has(key))continue;
      const radiusKm=routeRainZoneRadiusKm(row);
      if(radiusKm<=0)continue;
      const c=row.riding||ridingCondition(row);
      seen.add(key);
      zones.push({city:row.city,town:row.town,latitude:row.latitude,longitude:row.longitude,radiusKm,pop:Number(row.pop),weather:row.weather||"",score:c?.score});
    }
  }
  return zones;
}
function routeIntersectsRainZone(coords,zone){
  if(!Array.isArray(coords)||coords.length<2||!zone)return false;
  return routeDistanceToPointKm([zone.latitude,zone.longitude],coords)<=zone.radiusKm;
}
function routeRainZoneHits(coords,zones){
  return (zones||[]).filter(z=>routeIntersectsRainZone(coords,z));
}
function sameRouteArea(row,endpoint){
  return !!row&&!!endpoint&&
    String(row.city||"").replaceAll("臺","台")===String(endpoint.city||"").replaceAll("臺","台")&&
    String(row.town||"").replaceAll("臺","台")===String(endpoint.town||"").replaceAll("臺","台");
}
function routeRainyInteriorHits(analysis,from,to){
  return (analysis?.rainyInteriorPoints||[]).filter(item=>{
    const row=item.row||item;
    return !sameRouteArea(row,from)&&!sameRouteArea(row,to);
  });
}
function routeIsStrictlyRainFree(analysis,zones,from,to){
  return routeRainZoneHits(analysis.coords,zones).length===0 &&
    routeRainyInteriorHits(analysis,from,to).length===0;
}
function buildRainAvoidanceGatePairs(zones,from,to){
  const pairs=[],seen=new Set();
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude];
  const dx=b[1]-a[1],dy=b[0]-a[0],len=Math.hypot(dx,dy)||1;
  const ux=dx/len,uy=dy/len,nx=-uy,ny=ux;

  const nearestRows=(lat,lon)=>{
    return state.rows
      .filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude))
      .map(r=>{
        const wr=routeWeatherRow(r);
        const c=wr?.riding||ridingCondition(wr);
        return {r:wr,d:haversineKm([lat,lon],[r.latitude,r.longitude]),c};
      })
      .filter(x=>Number.isFinite(x.c?.score)&&x.c.score>=3&&(Number(x.c?.rainPenalty)||0)===0)
      .sort((x,y)=>x.d-y.d)
      .slice(0,6).map(x=>routeLocationObject(x.r));
  };

  for(const z of zones||[]){
    // 真正把 routing engine 帶到「雨區同一側」：
    // gate A 在雨區前方、gate B 在雨區後方，兩點都保持同一個側向偏移。
    // 舊版第一個 gate 放在雨區中心側邊，OSRM 仍可能先切進雨區再出去。
    const radiusDeg=Math.max(0.08,z.radiusKm/111.32);
    const sideOffset=Math.max(0.20,radiusDeg*2.15);
    const forwardOffset=Math.max(0.16,radiusDeg*1.55);

    for(const side of [-1,1]){
      const sideLat=ny*sideOffset*side;
      const sideLon=nx*sideOffset*side;
      const beforeLat=z.latitude-uy*forwardOffset+sideLat;
      const beforeLon=z.longitude-ux*forwardOffset+sideLon;
      const afterLat=z.latitude+uy*forwardOffset+sideLat;
      const afterLon=z.longitude+ux*forwardOffset+sideLon;
      const gateA=nearestRows(beforeLat,beforeLon);
      const gateB=nearestRows(afterLat,afterLon);

      for(const g1 of gateA.slice(0,3))for(const g2 of gateB.slice(0,3)){
        const key=z.city+"||"+z.town+"||"+side+"||"+g1.city+"||"+g1.town+"||"+g2.city+"||"+g2.town;
        if(seen.has(key))continue;
        seen.add(key);
        pairs.push({side,gates:[g1,g2],zone:z});
      }
    }
  }
  return pairs;
}

function selectBalancedRainGatePairs(pairs,limit=8){
  const buckets=new Map();
  for(const pair of pairs||[]){
    const key=(pair.zone?.city||"")+"||"+(pair.zone?.town||"");
    if(!buckets.has(key))buckets.set(key,{"-1":[],"1":[]});
    buckets.get(key)[String(pair.side)]?.push(pair);
  }
  const out=[];
  let index=0;
  while(out.length<limit){
    let added=false;
    for(const bucket of buckets.values()){
      for(const side of ["-1","1"]){
        const pair=bucket[side]?.[index];
        if(pair&&out.length<limit){out.push(pair);added=true;}
      }
    }
    if(!added)break;
    index++;
  }
  return out;
}

function buildRainAvoidanceGateRows(zones,from,to){
  const points=[],seen=new Set();
  const add=r=>{
    if(!r||!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))return;
    const key=r.city+"||"+r.town;if(seen.has(key))return;seen.add(key);points.push(routeLocationObject(r));
  };
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude];
  const dx=b[1]-a[1],dy=b[0]-a[0],len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len;
  for(const z of zones||[]){
    const offsets=[Math.max(0.14,z.radiusKm/111.32*1.45),Math.max(0.20,z.radiusKm/111.32*2.0)];
    for(const side of [-1,1])for(const off of offsets){
      const lat=z.latitude+ny*off*side,lon=z.longitude+nx*off*side;
      state.rows
        .filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude))
        .map(r=>{
          const wr=routeWeatherRow(r);
          const c=wr?.riding||ridingCondition(wr);
          return {r:wr,d:haversineKm([lat,lon],[r.latitude,r.longitude]),c};
        })
        .filter(x=>Number.isFinite(x.c?.score)&&x.c.score>=3&&(Number(x.c?.rainPenalty)||0)===0)
        .sort((x,y)=>x.d-y.d).slice(0,2).forEach(x=>add(x.r));
    }
  }
  return points.slice(0,28);
}

function buildRainAvoidanceAnchors(analyses,from,to){
  const points=[],seen=new Set();
  const add=r=>{
    if(!r||!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))return;
    const key=r.city+"||"+r.town;
    if(seen.has(key))return;
    seen.add(key);points.push(routeLocationObject(r));
  };
  const risky=[];
  analyses.forEach(a=>(a.rainyInteriorPoints||[]).forEach(x=>{
    const row=x.row||x;
    if(row&&Number.isFinite(row.latitude)&&Number.isFinite(row.longitude))risky.push(row);
  }));
  const unique=risky.filter((r,i,arr)=>arr.findIndex(x=>x.city===r.city&&x.town===r.town)===i);
  for(const bad of unique){
    // 以高風險鄉鎮為中心，優先尋找兩側較低降雨的鄉鎮作為「繞行門」。
    state.rows
      .filter(r=>r!==bad&&Number.isFinite(r.latitude)&&Number.isFinite(r.longitude))
      .map(r=>({r,d:haversineKm([bad.latitude,bad.longitude],[r.latitude,r.longitude]),pop:Number(r.pop)}))
      .filter(x=>{
        if(x.d>55)return false;
        const wr=routeWeatherRow(x.r);
        const c=wr?.riding||ridingCondition(wr);
        return Number.isFinite(c?.score)&&c.score>=3&&(Number(c?.rainPenalty)||0)===0;
      })
      .sort((a,b)=>(Number(a.r.pop)||0)-(Number(b.r.pop)||0)||a.d-b.d)
      .slice(0,8).forEach(x=>add(x.r));
  }
  // 同時加入高風險區域兩側的幾何偏移點，讓 OSRM 有機會選擇不同山谷／平面道路。
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude];
  const dx=b[1]-a[1],dy=b[0]-a[0],len=Math.hypot(dx,dy)||1;
  const nx=-dy/len,ny=dx/len;
  for(const bad of unique){
    for(const side of [-1,1]){
      const lat=bad.latitude+ny*0.22*side,lon=bad.longitude+nx*0.22*side;
      state.rows
        .filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude))
        .map(r=>{
          const wr=routeWeatherRow(r);
          const c=wr?.riding||ridingCondition(wr);
          return {r:wr,d:haversineKm([lat,lon],[r.latitude,r.longitude]),c};
        })
        .filter(x=>Number.isFinite(x.c?.score)&&x.c.score>=3&&(Number(x.c?.rainPenalty)||0)===0)
        .sort((x,y)=>x.d-y.d).slice(0,2).forEach(x=>add(x.r));
    }
  }
  return points.slice(0,24);
}

function yieldToBrowser(){
  return new Promise(resolve=>{
    if(typeof requestAnimationFrame==="function")requestAnimationFrame(()=>resolve());
    else setTimeout(resolve,0);
  });
}
async function analyzeRoutePoolAsync(routes,searchToken=null){
  const out=[];
  for(let i=0;i<(routes||[]).length;i++){
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return out;
    const a=routeCandidateAnalysis(routes[i]);
    if(a.coords.length>1&&a.route.distance>0)out.push(a);
    // 每分析 2 條路線就把主執行緒交還瀏覽器一次，避免地圖、按鈕與進度動畫卡死。
    if(i%2===1)await yieldToBrowser();
  }
  return out;
}
function updateAvoidanceProgress(percent,title,detail){
  const box=$("#routeResult");
  if(!box)return;
  const bar=box.querySelector(".route-search-progress-bar");
  const value=box.querySelector(".route-search-progress-value");
  const titleEl=box.querySelector(".route-search-progress-title");
  const detailEl=box.querySelector(".route-search-progress-detail");
  const p=Math.max(0,Math.min(100,Math.round(percent)));
  if(bar)bar.style.width=p+"%";
  if(value)value.textContent=p+"%";
  if(titleEl)titleEl.textContent=title||"正在規劃";
  if(detailEl)detailEl.textContent=detail||"";
}

async function searchAvoidanceRoutes(){
  if(!activeRouteEndpoints||routeAvoidanceSearching)return;
  const {from,to}=activeRouteEndpoints,box=$("#routeResult"),button=$("#analyzeRouteBtn"),fast=routeCandidates[0];
  if(!fast)return;

  const searchToken=beginRouteSearch();
  routeAvoidanceSearching=true;
  if(button)button.disabled=true;
  startRouteLoadingAnimation();
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  clearRouteMotorcycleAnimation();

  if(box){
    box.className="route-result route-normal";
    box.innerHTML='<div class="route-searching route-searching-advanced"><div class="route-search-icon" aria-hidden="true">🌂</div><strong>宣紙模式正在找不淋雨的路</strong><p class="route-search-progress-title">先確認起點與終點可以接上道路</p><div class="route-search-progress"><span class="route-search-progress-bar" style="width:4%"></span></div><div class="route-search-progress-meta"><span class="route-search-progress-detail">準備道路資料中…</span><strong class="route-search-progress-value">4%</strong></div><p class="route-searching-note">會先找幾條合理道路，再檢查哪些地方正在下雨；只有需要時才繼續繞路，不再一次把所有可能路線全部算完。</p></div>';
  }

  try{
    updateAvoidanceProgress(8,"正在接上實際道路","確認起點與終點附近可騎道路");
    await yieldToBrowser();
    if(!isRouteSearchActive(searchToken))return;
    const snapped=await snapRouteEndpoints(from,to,searchToken),sf=snapped.from,st=snapped.to;
    if(!isRouteSearchActive(searchToken))return;
    updateAvoidanceProgress(14,"先找幾條正常可走的路","正在建立第一批道路候選");
    await yieldToBrowser();
    const direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;
    const allAnchors=buildBroadRouteAnchors(from,to);
    // 宣紙模式不再一次把全部 anchor × 全部 routing server × alternatives 全部打出去。
    // 避免公開 OSRM / OSM DE 被 429 限流，也避免大量 timeout 讓整個搜尋看起來「跑不出來」。
    const anchors=allAnchors.slice(0,5);
    const routes=[],seenRoutes=new Set();

    const addRoutes=list=>{
      for(const route of list||[]){
        if(routeHasForbiddenNationalMain(route))continue;
        const coords=route.geometry?.coordinates||[];
        if(coords.length<2||!Number.isFinite(Number(route.distance))||Number(route.distance)<=0)continue;
        const key=coords.map(p=>p.join(",")).slice(0,24).join("|");
        if(!key||seenRoutes.has(key))continue;
        seenRoutes.add(key);
        routes.push(route);
      }
    };

    const roots={
      osrm:"https://router.project-osrm.org/",
      osmde:"https://routing.openstreetmap.de/routed-car/"
    };
    // 公開 OSRM 對 exclude=motorway 支援不一致，會直接回 400。
    // 宣紙模式改成先取得道路候選，再由 addRoutes() 的 routeHasForbiddenNationalMain() 嚴格淘汰國道主線。
    const baseQuery="?overview=full&geometries=geojson&steps=true&alternatives=false&continue_straight=false";
    const directQuery="?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false";
    const fallbackQuery=baseQuery;

    // 第一層：只使用 OSRM，且採少量、順序化請求。
    // direct + 8 anchors 已足以建立第一批道路候選。
    addRoutes(await requestOsrmRoutes(roots.osrm+"route/v1/driving/"+direct,directQuery,12000));
    if(!isRouteSearchActive(searchToken))return;
    updateAvoidanceProgress(22,"第一批道路已取得","接著看看附近還有沒有更適合避雨的走法");
    await yieldToBrowser();

    for(let anchorIndex=0;anchorIndex<anchors.length;anchorIndex++){
      const anchor=anchors[anchorIndex];
      const coords=sf.longitude+","+sf.latitude+";"+anchor.longitude+","+anchor.latitude+";"+st.longitude+","+st.latitude;
      const list=await requestOsrmRoutes(
        roots.osrm+"route/v1/driving/"+coords,
        baseQuery,
        11000
      );
      addRoutes(list);
      updateAvoidanceProgress(24+Math.round((anchorIndex+1)/Math.max(1,anchors.length)*16),"正在看看不同方向的道路","目前已整理 "+routes.length+" 條可用候選");
      await yieldToBrowser();
      // 候選足夠就提早進入氣象分析，不再為了湊數繼續打公開 routing server。
      if(routes.length>=12)break;
    }

    // 第二層：Valhalla 只補充 OSRM 找不到的道路候選，不大量併發。
    if(routes.length<5){
      updateAvoidanceProgress(42,"道路候選偏少","再用另一個機車路由引擎補幾條路");
      for(const anchor of anchors.slice(0,3)){
        const route=await requestValhallaFlatRoute(sf,st,[anchor]);
        if(!isRouteSearchActive(searchToken))return;
        if(route&&!routeHasForbiddenNationalMain(route))addRoutes([route]);
        if(routes.length>=8)break;
      }
    }

    updateAvoidanceProgress(48,"開始看沿途天氣","逐段檢查候選道路附近的氣象資料");
    await yieldToBrowser();
    let pool=await analyzeRoutePoolAsync(routes,searchToken);
    if(!isRouteSearchActive(searchToken))return;
    updateAvoidanceProgress(56,"已找出需要避開的天氣區域","準備建立繞開雨區的安全導引點");
    await yieldToBrowser();

    // 第二階段：先用第一輪結果找出雨區，再建立安全 gate。
    // 注意：這一階段也限制請求數，避免再度觸發公開 routing service 的 429。
    let rainZones=buildRainAvoidanceZones(pool)
      .filter(z=>!sameRouteArea(z,from)&&!sameRouteArea(z,to));

    if(pool.length && rainZones.length){
      const rainAvoidanceAnchors=buildRainAvoidanceAnchors(pool,from,to).slice(0,4);
      const rainAvoidanceGateRows=buildRainAvoidanceGateRows(rainZones,sf,st).slice(0,4);
      const rainAvoidanceGatePairs=selectBalancedRainGatePairs(buildRainAvoidanceGatePairs(rainZones,sf,st),6);
      const rerouteAnchors=[...rainAvoidanceAnchors,...rainAvoidanceGateRows];

      // 第三層：OSRM 只補充少量「繞雨區」候選。
      updateAvoidanceProgress(62,"正在真的繞開雨區","改走雨區外圍的安全道路方向");
      for(let i=0;i<rerouteAnchors.length;i++){
        const anchor=rerouteAnchors[i];
        const coords=sf.longitude+","+sf.latitude+";"+anchor.longitude+","+anchor.latitude+";"+st.longitude+","+st.latitude;
        const list=await requestOsrmRoutes(
          roots.osrm+"route/v1/driving/"+coords,
          baseQuery,
          11000
        );
        if(!isRouteSearchActive(searchToken))return;
        addRoutes(list);
        updateAvoidanceProgress(62+Math.round((i+1)/Math.max(1,rerouteAnchors.length)*12),"正在真的繞開雨區","已找到 "+routes.length+" 條道路候選");
        await yieldToBrowser();
        if(routes.length>=18)break;
      }

      // 第四層：只有 OSRM 補充不足時才使用 OSM DE。
      // 不再把 OSM DE 與 OSRM 同時大量平行請求，避免 429。
      if(routes.length<12){
        for(const anchor of rerouteAnchors.slice(0,3)){
          const coords=sf.longitude+","+sf.latitude+";"+anchor.longitude+","+anchor.latitude+";"+st.longitude+","+st.latitude;
          const list=await requestOsrmRoutes(
            roots.osmde+"route/v1/driving/"+coords,
            fallbackQuery,
            9000
          );
          if(!isRouteSearchActive(searchToken))return;
          addRoutes(list);
          if(routes.length>=16)break;
        }
      }

      // 雙 gate 是 hard avoidance 的核心，不能因為前面已經累積很多「壞候選」就跳過。
      // 舊邏輯 routes.length >= 20 時會直接略過這一段，這正是烏來仍可能被穿越的主要原因之一。
      for(const pair of rainAvoidanceGatePairs){
        const g1=pair.gates[0],g2=pair.gates[1];
        if(!g1||!g2)continue;
        const coords=sf.longitude+","+sf.latitude+";"+g1.longitude+","+g1.latitude+";"+g2.longitude+","+g2.latitude+";"+st.longitude+","+st.latitude;
        const list=await requestOsrmRoutes(
          roots.osrm+"route/v1/driving/"+coords,
          baseQuery,
          11000
        );
        if(!isRouteSearchActive(searchToken))return;
        addRoutes(list);
        updateAvoidanceProgress(78,"檢查雨區兩側的繞行門","確認道路不會切回高風險區");
        await yieldToBrowser();
        if(routes.length>=22)break;
      }

      updateAvoidanceProgress(82,"重新驗證新的繞行路線","逐條確認是否真的沒有穿過雨區");
      await yieldToBrowser();
      pool=await analyzeRoutePoolAsync(routes,searchToken);
      if(!isRouteSearchActive(searchToken))return;

      // 保留第一輪偵測到的雨區；新候選可能本身沒有進入雨區，
      // 不應因重新分析而把原本的避雨目標洗掉。
      const refreshedRainZones=buildRainAvoidanceZones(pool)
        .filter(z=>!sameRouteArea(z,from)&&!sameRouteArea(z,to));
      const zoneMap=new Map(rainZones.map(z=>[z.city+"||"+z.town,z]));
      refreshedRainZones.forEach(z=>zoneMap.set(z.city+"||"+z.town,z));
      rainZones=[...zoneMap.values()];
    }

    if(!pool.length)throw new Error("宣紙模式沒有取得可驗證的替代道路候選。");

    // 核心規則：
    // 1. 穿越任何 hard rain / Score-1 zone 的候選直接淘汰。
    // 2. 不再使用 legacyRainFree 回補，因為它只看採樣點，可能把實際穿過烏來 buffer 的路線重新放回來。
    // 3. 若第一輪完全沒有 hard-safe route，再做一次較完整的雙 Gate 救援搜尋；仍找不到才允許 fallback。
    let strictRainFree=pool.filter(x=>routeIsStrictlyRainFree(x,rainZones,from,to));

    if(!strictRainFree.length&&rainZones.length){
      updateAvoidanceProgress(88,"還沒有完全乾燥的路","最後再試幾組更外圍的安全繞行");
      const rescuePairs=selectBalancedRainGatePairs(buildRainAvoidanceGatePairs(rainZones,sf,st),12);
      for(let rescueIndex=0;rescueIndex<rescuePairs.length;rescueIndex++){
        const pair=rescuePairs[rescueIndex];
        const g1=pair.gates[0],g2=pair.gates[1];
        if(!g1||!g2)continue;
        const coords=sf.longitude+","+sf.latitude+";"+g1.longitude+","+g1.latitude+";"+g2.longitude+","+g2.latitude+";"+st.longitude+","+st.latitude;
        const list=await requestOsrmRoutes(
          roots.osrm+"route/v1/driving/"+coords,
          baseQuery,
          12000
        );
        if(!isRouteSearchActive(searchToken))return;
        addRoutes(list);
        updateAvoidanceProgress(88+Math.round((rescueIndex+1)/Math.max(1,rescuePairs.length)*6),"最後一輪避雨搜尋","嘗試第 "+(rescueIndex+1)+" / "+rescuePairs.length+" 組安全繞行");
        await yieldToBrowser();
      }

      pool=await analyzeRoutePoolAsync(routes,searchToken);
      if(!isRouteSearchActive(searchToken))return;
      const rescuedZones=buildRainAvoidanceZones(pool)
        .filter(z=>!sameRouteArea(z,from)&&!sameRouteArea(z,to));
      const zoneMap=new Map(rainZones.map(z=>[z.city+"||"+z.town,z]));
      rescuedZones.forEach(z=>zoneMap.set(z.city+"||"+z.town,z));
      rainZones=[...zoneMap.values()];
      strictRainFree=pool.filter(x=>routeIsStrictlyRainFree(x,rainZones,from,to));
    }

    const rainFree=strictRainFree;

    const ranked=(rainFree.length?rainFree:pool).slice().sort((x,y)=>{
      const xSampleHits=routeRainyInteriorHits(x,from,to).length;
      const ySampleHits=routeRainyInteriorHits(y,from,to).length;
      if(!rainFree.length&&xSampleHits!==ySampleHits)return xSampleHits-ySampleHits;
      const xHits=routeRainZoneHits(x.coords,rainZones).length;
      const yHits=routeRainZoneHits(y.coords,rainZones).length;
      if(!rainFree.length&&xHits!==yHits)return xHits-yHits;

      if(x.rainMetric!==y.rainMetric)return x.rainMetric-y.rainMetric;
      const xMax=x.maxPop??Infinity,yMax=y.maxPop??Infinity;
      if(xMax!==yMax)return xMax-yMax;

      const badDiff=x.badInteriorPoints.length-y.badInteriorPoints.length;
      if(badDiff)return badDiff;

      const xMin=x.interiorConditions.length?Math.min(...x.interiorConditions.map(c=>c.score)):99;
      const yMin=y.interiorConditions.length?Math.min(...y.interiorConditions.map(c=>c.score)):99;
      if(xMin!==yMin)return yMin-xMin;

      const severeDiff=(x.severeInteriorPoints?.length||0)-(y.severeInteriorPoints?.length||0);
      if(severeDiff)return severeDiff;

      return x.route.duration-y.route.duration;
    });

    updateAvoidanceProgress(97,"正在選最後一條路","比較降雨風險、最差 Score 與道路時間");
    await yieldToBrowser();
    const risk=ranked[0];
    if(!risk)throw new Error("宣紙模式沒有可驗證的避雨路線。");

    risk.rainZoneHits=routeRainZoneHits(risk.coords,rainZones);
    risk.rainyInteriorHits=routeRainyInteriorHits(risk,from,to);
    risk.rainZoneAvoided=risk.rainZoneHits.length===0&&risk.rainyInteriorHits.length===0;
    risk.avoidanceFallback=!rainFree.length;
    risk.avoidanceCheckedCandidates=pool.length;
    risk.avoidanceDetectedZones=rainZones.map(z=>({city:z.city,town:z.town,pop:z.pop,score:z.score}));

    updateAvoidanceProgress(
      100,
      risk.avoidanceFallback?"完成，但沒有完全避雨":"完成",
      risk.avoidanceFallback
        ?"已擴大驗證候選；目前只能提供最低降雨風險的備援路線"
        :"已找到完全避開目前偵測雨區的道路"
    );
    await yieldToBrowser();
    routeCandidates=[fast,risk];
    activeRouteCandidateIndex=1;
    activateRouteCandidate(1);
  }catch(e){
    if(!isRouteSearchActive(searchToken))return;
    console.error(e);
    routeCandidates=[fast];
    activeRouteCandidateIndex=0;
    if(box){
      box.className="route-result route-caution";
      box.innerHTML='<strong>宣紙模式搜尋失敗</strong><p class="route-hint">'+e.message+'</p><p class="route-hint">最快路線沒有變更；請再次點選「宣紙模式」重新搜尋。</p>';
    }
    activateRouteCandidate(0);
  }finally{
    if(isRouteSearchActive(searchToken)){
      routeAvoidanceSearching=false;
      stopRouteLoadingAnimation();
      if(button){button.disabled=false;button.textContent="分析這段路的可騎行性";}
    }
  }
}
function activateRouteCandidate(index){
  const a=routeCandidates[index];if(!a||!activeRouteEndpoints)return;activeRouteCandidateIndex=index;
  const from=activeRouteEndpoints.from,to=activeRouteEndpoints.to,route=a.route,box=$("#routeResult"),fast=routeCandidates[0],avoidanceMode=index===1;
  const endpointWarnings=endpointRiskWarning(from,to);
  const endpointWarningHTML=endpointWarnings.length
    ? '<div class="route-endpoint-warning"><strong>⚠️ 起終點騎乘提醒</strong><div>'+endpointWarnings.map(w=>w.label+"「"+w.row.city+"｜"+w.row.town+"」目前為 "+w.condition.icon+" "+w.condition.label+"（Score "+w.condition.score+" / 5）"+(w.condition.reasons?.length?"，主要因素："+w.condition.reasons.join("、"):"")).join("<br>")+'</div><small>此提醒只針對起點／終點本身，不會因此觸發宣紙模式。</small></div>'
    : "";
  const lvl=avoidanceMode
    ? (a.minScore==null?{level:"normal",label:"資料不足",icon:"🟡"}:routeLevel(a.minScore))
    : {level:"normal",label:"最快路線",icon:"⚡"};
  const decision=avoidanceMode?routeDecision(lvl.level):{icon:"⚡",label:"依預估時間選擇"};
  const worst=a.nearby.filter(x=>Number.isFinite((x.row.riding||ridingCondition(x.row)).score)).reduce((b,x)=>!b||((x.row.riding||ridingCondition(x.row)).score<(b.row.riding||ridingCondition(b.row)).score)?x:b,a.nearby[0]);
  const reasons=[...new Set(a.conditions.flatMap(c=>c.reasons||[]))],minutes=Math.round(route.duration/60),extra=Math.max(0,minutes-Math.round(fast.route.duration/60));
  const hasSaferAlternative=routeCandidates.length>1&&routeCandidates[1]!==fast&&routeCandidates[1].rainMetric<fast.rainMetric;
  const avoidanceFallback=avoidanceMode&&a.avoidanceFallback===true;
  const avoidanceUnavoidable=avoidanceMode&&!hasSaferAlternative;
  const rainLabel=a.rainMetric>=3?"高":a.rainMetric>=2?"中高":a.rainMetric>=1?"中":"低";
  box.className="route-result "+(avoidanceMode?routeClass(lvl.level):"route-normal");
  box.innerHTML='<div class="route-result-head"><div class="route-result-title">'+from.city+"｜"+from.town+" → "+to.city+"｜"+to.town+'</div><strong class="route-result-level">'+lvl.icon+" "+lvl.label+'</strong></div><div class="route-policy-badge">'+routeRegionReminder(from,to)+' · 🚫 已啟用：避開高速公路（國道主線全部排除）</div>'+endpointWarningHTML+'<div class="route-options"><button type="button" class="route-option '+(index===0?"active":"")+'" data-route-index="0"><div class="route-option-title"><strong>最快路線</strong><span>⚡</span></div><div class="route-option-meta"><span>'+Math.round(fast.route.duration/60)+' 分鐘</span><span>'+(fast.route.distance/1000).toFixed(1)+' km</span></div><div class="route-option-note">以避開高速公路後的最短預估時間為優先</div></button>'+(routeCandidates[1]
  ? '<button type="button" class="route-option '+(index===1?"active":"")+'" data-route-index="1"><div class="route-option-title"><strong>'+(routeCandidates[1].avoidanceFallback?"宣紙模式 · 未完全避雨":"宣紙模式")+'</strong><span>🌂</span></div><div class="route-option-meta"><span>'+Math.round(routeCandidates[1].route.duration/60)+' 分鐘</span><span>'+(routeCandidates[1].route.distance/1000).toFixed(1)+' km</span><span>'+(routeCandidates[1].avoidanceFallback?"最低風險備援":"完全避開偵測雨區")+'</span></div><div class="route-option-note">'+(routeCandidates[1].avoidanceFallback?"已擴大搜尋，但本次路由候選仍無法完全避開高降雨區；此結果是最低風險備援，不代表道路網絕對沒有其他路。":"我就是不想淋雨，我有的是時間。<br>已驗證路線沒有穿過目前偵測到的雨區。")+'</div></button>'
  : '<button type="button" class="route-option" data-route-index="1"><div class="route-option-title"><strong>宣紙模式</strong><span>🧭</span></div><div class="route-option-meta"><span>重新搜尋</span><span>最低降雨風險優先</span></div><div class="route-option-note">我就是不想淋雨，我有的是時間。<br>重新搜尋更廣泛的道路候選，計算會比最快路線久。</div></button>')+'</div><div class="route-score-row"><div class="route-score"><strong>'+(a.minScore==null?"--":a.minScore)+'</strong><span>'+"最差 Score"+'</span></div><div class="route-summary">'+(avoidanceMode
    ? (avoidanceFallback
      ? "⚠️ 本次已驗證 "+(a.avoidanceCheckedCandidates||0)+" 條道路候選，仍沒有找到完全避開高降雨區的可驗證路線。這代表目前公開路由服務的本次搜尋未找到乾燥路線，不等於證明整個道路網絕對無路；因此此結果只標示為最低風險備援。"
      : (avoidanceUnavoidable
        ? "目前沒有找到比最快路線更低降雨風險的替代路線，因此維持最快路線。"
        : "宣紙模式已找到完全避開目前偵測雨區的可驗證道路；距離與車程不設上限。"))
    : "本路線僅以避開高速公路後的最短預估時間為選擇依據；騎乘適合度不參與最快路線的選路。")+"<br>依道路路線沿線 "+a.nearby.length+" 個氣象資料點分析。<br><strong>建議："+decision.icon+" "+decision.label+'</strong><br>最需注意路段：'+(worst?worst.row.city+"｜"+worst.row.town:"--")+'</div></div><div class="route-evidence"><div><span>道路距離</span><strong>'+(route.distance/1000).toFixed(1)+' km</strong></div><div><span>預估車程</span><strong>'+minutes+' 分鐘</strong></div><div><span>沿線平均 Score</span><strong>'+(a.avgScore==null?"--":a.avgScore.toFixed(1))+'</strong></div></div><div class="route-reasons">主要因素：'+(reasons.length?reasons.join("、"):"目前沒有明顯不利因素")+'<br><span>沿線最高降雨機率：'+(a.maxPop==null?"--":a.maxPop+" %")+'</span></div><details class="route-points-collapse"><summary>🛣️ 查看沿線 '+a.nearby.length+' 個氣象資料點</summary><div class="route-points-list">'+a.nearby.map((x,i)=>{const r=x.row,c=r.riding||ridingCondition(r);return '<div class="route-point-entry"><div class="route-point '+routeClass(c.level)+'" data-route-point-index="'+i+'" role="button" tabindex="0" aria-expanded="false"><div class="route-point-index">'+(i+1)+'</div><div><div class="route-point-title"><strong>'+r.city+"｜"+r.town+'</strong><span>'+c.icon+" "+c.label+'</span></div><div class="route-point-metrics"><span class="route-point-score">'+(Number.isFinite(c.score)?"Score "+c.score+" / 5":"資料不足")+'</span><span>🌡️ '+fmt(r.temperature," °C")+'</span><span>💧 '+fmt(r.humidity," %")+'</span><span>🌧️ '+fmt(r.pop," %")+'</span><span>💨 '+fmt(r.windSpeed," m/s")+'</span></div><div class="route-point-weather">'+(r.weather||"天氣資料不足")+" · "+(r.windDirection||"風向未知")+'</div><div class="route-point-expand-hint">查看完整天氣 ＋</div></div></div><div class="route-point-expanded hidden"></div></div>';}).join("")+'</div></details>';
  bindRoutePointExpanders(box,a);
  box.querySelectorAll(".route-option").forEach(b=>b.addEventListener("click",()=>{
    const routeIndex=Number(b.dataset.routeIndex);
    if(routeIndex===1&&!routeCandidates[1]){searchAvoidanceRoutes();return;}
    activateRouteCandidate(routeIndex);
  }));
  if(taiwanMap){if(routeLayer)routeLayer.remove();routeLayer=L.polyline(a.coords,{color:avoidanceMode?"#60a5fa":"#7dd3fc",weight:5,opacity:.85}).addTo(taiwanMap);taiwanMap.fitBounds(L.latLngBounds(a.coords).pad(.12));renderRouteEndpoints(from,to);startRouteMotorcycleAnimation(a.coords);}
}
function buildDetourWaypoints(from,to){
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude],candidates=[];
  const dx=b[1]-a[1],dy=b[0]-a[0];
  for(const ratio of [.2,.35,.5,.65,.8]){
    const lat=a[0]+dy*ratio,lon=a[1]+dx*ratio;
    const nearby=state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&r.city!==from.city&&r.city!==to.city)
      .map(r=>({r,d:Math.hypot((r.latitude-lat)*1.1,(r.longitude-lon)*Math.cos(lat*Math.PI/180))}))
      .sort((x,y)=>x.d-y.d);
    const pick=nearby[0]?.r;
    if(pick&&!candidates.some(x=>x.city===pick.city&&x.town===pick.town))candidates.push(pick);
  }
  return candidates;
}
function buildBroadRouteAnchors(from,to){
  const points=[],seen=new Set();
  const add=r=>{
    if(!r||!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))return;
    const key=r.city+"||"+r.town;
    if(seen.has(key))return;
    seen.add(key);points.push(routeLocationObject(r));
  };
  buildDetourWaypoints(from,to).forEach(add);
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude],dx=b[1]-a[1],dy=b[0]-a[0];
  for(const ratio of [.12,.24,.36,.48,.60,.72,.84,.92]){
    const lat=a[0]+dy*ratio,lon=a[1]+dx*ratio;
    state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&r.city!==from.city&&r.city!==to.city)
      .map(r=>({r,d:haversineKm([lat,lon],[r.latitude,r.longitude])}))
      .sort((x,y)=>x.d-y.d).slice(0,2).forEach(x=>add(x.r));
  }
  return points.slice(0,18);
}
async function requestOsrmRoutes(base,query,timeoutMs=18000){
  const managed=createRouteAbortController(timeoutMs);
  try{
    const res=await fetch(base+query,{signal:managed.controller.signal});
    const text=await res.text();let data=null;try{data=JSON.parse(text)}catch(_){}
    return res.ok&&data?.code==="Ok"&&Array.isArray(data.routes)?data.routes:[];
  }catch(_){return []}finally{managed.done();}
}
async function requestOsrmNearest(base,lat,lon,timeoutMs=12000){
  const managed=createRouteAbortController(timeoutMs);
  try{
    const res=await fetch(base+"nearest/v1/driving/"+lon+","+lat+"?number=1",{signal:managed.controller.signal});
    const data=await res.json().catch(()=>null);
    return res.ok&&data?.code==="Ok"&&data?.waypoints?.[0]?.location?data.waypoints[0].location:null;
  }catch(_){return null}finally{managed.done();}
}
async function snapRouteEndpoint(row,searchToken=null){
  const fixed=fixedRouteOrigin(row);
  const target=fixed||routeLocationObject(row);
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  for(const root of roots){
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return target;
    const p=await requestOsrmNearest(root,Number(target.latitude),Number(target.longitude),root.includes("project-osrm")?5500:4500);
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return target;
    if(p){
      return {
        longitude:Number(p[0]),
        latitude:Number(p[1]),
        city:row.city,
        town:row.town,
        fixedOriginName:target.fixedOriginName||"",
        fixedOriginAddress:target.fixedOriginAddress||""
      };
    }
  }
  return target;
}
async function snapRouteEndpoints(from,to,searchToken=null){
  const [a,b]=await Promise.all([
    snapRouteEndpoint(from,searchToken),
    snapRouteEndpoint(to,searchToken)
  ]);
  return {from:a,to:b};
}
async function requestRouteFromServers(coords,options="",searchToken=null){
  const bases=[
    "https://router.project-osrm.org/",
    "https://routing.openstreetmap.de/routed-car/"
  ];
  for(const root of bases){
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return [];
    const routes=await requestOsrmRoutes(root+"route/v1/driving/"+coords,options,18000);
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return [];
    if(routes.length)return routes;
  }
  return [];
}
// isQiduRow 已在固定起點設定區定義，七堵路線一律使用七堵車站作為起點。
async function requestQiduLocalRoutes(from,to,searchToken=null){
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  const qidu=isQiduRow(from)?from:to;
  const qOrigin=fixedRouteOrigin(qidu)||routeLocationObject(qidu);
  const qLat=Number(qOrigin.latitude),qLon=Number(qOrigin.longitude);
  if(!Number.isFinite(qLat)||!Number.isFinite(qLon))return [];

  // 七堵是山谷、交流道與平面道路高度交疊的區域。
  // 策略重點：
  // 1. nearest 只是「優化吸附」，不再是進入七堵策略的必要條件。
  // 2. 先讓 OSRM 產生候選，再由 RideSky 驗證是否含國道主線。
  // 3. 若一般候選全部被國道過濾，再以 exclude=motorway 做第二輪錨點搜尋。
  const anchors=[];
  const radii=[0.008,0.018];
  anchors.push({latitude:qLat,longitude:qLon});
  for(const radius of radii){
    for(let deg=0;deg<360;deg+=45){
      const rad=deg*Math.PI/180;
      anchors.push({
        latitude:qLat+radius*Math.sin(rad),
        longitude:qLon+(radius*Math.cos(rad))/Math.cos(qLat*Math.PI/180)
      });
    }
  }

  const results=[];
  for(const root of roots){
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return results;
    // nearest 成功時優先使用吸附後道路點；失敗時直接退回原始行政區座標。
    // 這裡刻意不讓 nearest 服務成為七堵路由的硬性依賴。
    const fromOrigin=fixedRouteOrigin(from)||routeLocationObject(from);
    const sf=(await requestOsrmNearest(root,Number(fromOrigin.latitude),Number(fromOrigin.longitude),12000))
      || [Number(fromOrigin.longitude),Number(fromOrigin.latitude)];
    const st=(await requestOsrmNearest(root,Number(to.latitude),Number(to.longitude),12000))
      || [Number(to.longitude),Number(to.latitude)];

    if(!Number.isFinite(sf[0])||!Number.isFinite(sf[1])||!Number.isFinite(st[0])||!Number.isFinite(st[1]))continue;

    const runAnchors=async query=>{
      if(searchToken!=null&&!isRouteSearchActive(searchToken))return;
      const jobs=anchors.map(anchor=>{
        const coords=sf[0]+","+sf[1]+";"+anchor.longitude+","+anchor.latitude+";"+st[0]+","+st[1];
        return requestOsrmRoutes(
          root+"route/v1/driving/"+coords,
          query,
          22000
        );
      });
      const batches=[];
      for(let i=0;i<jobs.length;i+=4)batches.push(jobs.slice(i,i+4));
      for(const batch of batches){
        if(searchToken!=null&&!isRouteSearchActive(searchToken))return;
        const routeGroups=await Promise.all(batch);
        if(searchToken!=null&&!isRouteSearchActive(searchToken))return;
        for(const routes of routeGroups){
          for(const route of routes){
            if(!routeHasForbiddenNationalMain(route))results.push(route);
          }
        }
      }
    };

    // 第一輪：不要先 exclude motorway，保留 OSRM 尋找替代道路的能力，
    // 最後再由 RideSky 自己淘汰國道主線。
    await runAnchors("?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false");
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return results;
    if(results.length)break;

    // 第二輪：若 OSRM 的 alternatives 幾乎全部被國道主線包住，
    // 再要求引擎本身避開 motorway，搭配七堵周邊錨點重新搜尋。
    await runAnchors("?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false&exclude=motorway");
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return results;
    if(results.length)break;
  }
  return results;
}
async function requestSnappedAvoidMotorway(from,waypoints,to){
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  const raw=[from,...waypoints,...[to]];
  for(const root of roots){
    const snapped=[];
    let ok=true;
    for(const r of raw){
      const p=await requestOsrmNearest(root,r.latitude,r.longitude);
      if(!p){ok=false;break;}
      snapped.push(p[0]+","+p[1]);
    }
    if(!ok)continue;
    const query="?overview=full&geometries=geojson&steps=true&alternatives=3&continue_straight=false&exclude=motorway";
    const routes=await requestOsrmRoutes(root+"route/v1/driving/"+snapped.join(";"),query,22000);
    const valid=routes.filter(route=>!routeHasForbiddenNationalMain(route));
    if(valid.length)return {routes:valid,mode:"快速道路／平面道路混合"};
  }
  return {routes:[],mode:""};
}
function decodePolyline6(str){
  let index=0,lat=0,lng=0,out=[];
  while(index<str.length){
    let result=0,shift=0,b;
    do{b=str.charCodeAt(index++)-63;result|=(b&31)<<shift;shift+=5;}while(b>=32);
    lat+=result&1?~(result>>1):result>>1;
    result=0;shift=0;
    do{b=str.charCodeAt(index++)-63;result|=(b&31)<<shift;shift+=5;}while(b>=32);
    lng+=result&1?~(result>>1):result>>1;
    out.push([lat/1e6,lng/1e6]);
  }
  return out;
}
async function requestValhallaFlatRoute(from,to,waypoints=[]){
  const locations=[from,...waypoints,to].map(r=>({lat:r.latitude,lon:r.longitude,type:"break"}));
  const payload={
    locations,
    costing:"motorcycle",
    costing_options:{motorcycle:{use_highways:0,use_trails:0}},
    units:"kilometers",
    directions_options:{units:"kilometers"}
  };
  const managed=createRouteAbortController(22000);
  try{
    const res=await fetch("https://valhalla1.openstreetmap.de/route",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Client-Id":"ridesky-weather"},
      body:JSON.stringify(payload),
      signal:managed.controller.signal
    });
    const data=await res.json().catch(()=>null);
    const trip=data?.trip;
    if(!res.ok||!trip?.legs?.length||!Array.isArray(trip.legs))return null;
    const coords=[];
    const steps=[];
    for(const leg of trip.legs){
      if(leg.shape){
        const part=decodePolyline6(leg.shape);
        if(part.length)coords.push(...(coords.length?part.slice(1):part));
      }
      for(const m of leg.maneuvers||[]){
        const names=(m.street_names||[]).map(x=>x.value||x.text||String(x)).join(" ");
        const instruction=[m.verbal_pre_transition_instruction,m.verbal_post_transition_instruction].filter(Boolean).join(" ");
        steps.push({name:names,ref:"",destinations:instruction});
      }
    }
    if(coords.length<2)return null;
    const summary=trip.summary||{};
    const route={
      distance:Number(summary.length||0)*1000,
      duration:Number(summary.time||0),
      geometry:{type:"LineString",coordinates:coords.map(p=>[p[1],p[0]])},
      legs:[{steps}]
    };
    if(!route.distance){
      route.distance=coords.reduce((s,p,i)=>i?s+routeDistance([coords[i-1][0],coords[i-1][1]],[p[0],p[1]]):0,0);
    }
    return route;
  }catch(_){return null}finally{managed.done();}
}
async function collectFastRouteCandidates(sf,st,waypoints=[],searchToken=null){
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  const routes=[],seen=new Set();
  const addRoutes=list=>{
    for(const route of list||[]){
      if(routeHasForbiddenNationalMain(route))continue;
      if(!routeLooksPlausible(route,sf,st))continue;
      const key=(route.geometry?.coordinates||[]).map(p=>p.join(",")).slice(0,12).join("|");
      if(!key||seen.has(key))continue;
      seen.add(key);routes.push(route);
    }
  };
  const direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;
  const fastQuery="?overview=full&geometries=geojson&steps=true&alternatives=3&continue_straight=false&exclude=motorway";
  const relaxedQuery="?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false";

  // Fast Path：直接點對點本來就是同一限制下的最短時間解。
  // 正常案例只打一個主要 OSRM 請求，成功就立刻返回，不再先跑十幾個 anchors。
  for(const root of roots){
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
    addRoutes(await requestOsrmRoutes(root+"route/v1/driving/"+direct,fastQuery,root.includes("project-osrm")?9000:7000));
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
    if(routes.length)return routes.sort((a,b)=>a.duration-b.duration);

    // 部分公開 OSRM profile 不支援 exclude=motorway；改由 RideSky 自己檢查國道主線。
    addRoutes(await requestOsrmRoutes(root+"route/v1/driving/"+direct,relaxedQuery,root.includes("project-osrm")?8000:6500));
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
    if(routes.length)return routes.sort((a,b)=>a.duration-b.duration);
  }

  // 只有 direct 找不到合法道路時，才使用少量「幾何上有意義」的 anchor 救援。
  // waypoint 強迫繞行，不可能比成功的 direct shortest path 更快，因此不應出現在正常 Fast Path。
  for(const anchor of waypoints.slice(0,3)){
    for(const root of roots){
      if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
      const coords=sf.longitude+","+sf.latitude+";"+anchor.longitude+","+anchor.latitude+";"+st.longitude+","+st.latitude;
      addRoutes(await requestOsrmRoutes(root+"route/v1/driving/"+coords,fastQuery,7000));
      if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
      if(routes.length)return routes.sort((a,b)=>a.duration-b.duration);
    }
  }

  // 最後才用 Valhalla 機車路由備援。
  for(const anchor of [null,...waypoints.slice(0,2)]){
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
    const route=await requestValhallaFlatRoute(sf,st,anchor?[anchor]:[]);
    if(searchToken!=null&&!isRouteSearchActive(searchToken))return routes;
    if(route&&!routeHasForbiddenNationalMain(route)&&routeLooksPlausible(route,sf,st))addRoutes([route]);
    if(routes.length)return routes.sort((a,b)=>a.duration-b.duration);
  }
  return routes;
}
async function analyzeRoute(){
  const searchToken=beginRouteSearch();
  // 點擊重新規劃的瞬間就清除上一輪結果，避免新舊路線同時留在畫面上。
  clearRouteMotorcycleAnimation();
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  clearRouteEndpoints();
  routeCandidates=[];activeRouteCandidateIndex=0;activeRouteEndpoints=null;
  const box=$("#routeResult");
  if(box){box.className="route-result hidden";box.innerHTML="";}
  const from=findRouteRow($("#routeFrom")?.value),to=findRouteRow($("#routeTo")?.value);
  if(!from||!to){if(box){box.className="route-result";box.innerHTML="<strong>請先選擇起點與終點。</strong>"}return;}
  if(from.city===to.city&&from.town===to.town){if(box){box.className="route-result";box.innerHTML="<strong>起點與終點不能相同。</strong>"}return;}
  const policy=routeRegionPolicy(from,to);
  if(!policy.allowed){
    if(box){box.className="route-result route-normal";box.innerHTML="<strong>目前無法規劃這段道路路線</strong><p class=\"route-hint\">🚢 "+policy.message+"</p><p class=\"route-hint\">目前選擇："+from.city+"｜"+from.town+" → "+to.city+"｜"+to.town+"</p><p class=\"route-hint\">請改選同一島群內的鄉鎮；系統不會嘗試把海運／空運當成道路路線。</p>"}
    return;
  }
  const button=$("#analyzeRouteBtn");
  button.disabled=true;
  startRouteLoadingAnimation();
  try{
    // Fast Path 不先呼叫 nearest：OSRM route 本身就會把座標吸附到可行道路。
    // 只有直接 routing 真的失敗時，才付出 explicit nearest 的額外等待成本。
    let sf=routeLocationObject(from),st=routeLocationObject(to);
    let direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;
    const waypoints=buildBroadRouteAnchors(from,to);
    let valid=[];
    let routingMode="";

    valid=await collectFastRouteCandidates(sf,st,waypoints,searchToken);
    if(!isRouteSearchActive(searchToken))return;
    if(valid.length)routingMode="快速道路／平面道路 · Fast Path";

    if(!valid.length){
      const snapped=await snapRouteEndpoints(from,to,searchToken);
      if(!isRouteSearchActive(searchToken))return;
      sf=snapped.from;st=snapped.to;
      direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;
      valid=await collectFastRouteCandidates(sf,st,waypoints.slice(0,3),searchToken);
      if(valid.length)routingMode="道路吸附後快速路由";
    }

    // 七堵專用處理：七堵地形與國道／快速道路高度交疊，
    // 若第一輪候選全部無法通過驗證，再啟用七堵專用道路錨點策略。
    if(!valid.length && (isQiduRow(from)||isQiduRow(to))){
      valid=await requestQiduLocalRoutes(from,to,searchToken);
      if(!isRouteSearchActive(searchToken))return;
      if(valid.length)routingMode="七堵平面道路專用策略";
    }

    // 2. Valhalla motorcycle：即使 OSRM 暫時無法服務，也不能因單一引擎失敗就判定無路。
    if(!valid.length){
      const flatPoints=[[],waypoints.slice(0,1),waypoints.slice(0,2),waypoints.slice(0,3)];
      for(const selected of flatPoints){
        const route=await requestValhallaFlatRoute(sf,st,selected);
        if(!isRouteSearchActive(searchToken))return;
        if(route&&!routeHasForbiddenNationalMain(route)){valid=[route];routingMode="Valhalla 機車平面道路備援";break;}
      }
    }

    // 4. 最後才允許一般 OSRM route 作為救援，再做國道主線驗證。
    if(!valid.length){
      valid=(await requestRouteFromServers(direct,"?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false",searchToken))
        .filter(route=>!routeHasForbiddenNationalMain(route));
      if(!isRouteSearchActive(searchToken))return;
      if(valid.length)routingMode="一般道路救援（已驗證無國道主線）";
    }

    // 5. 再以原始行政區中心點做一次 Valhalla；避免 nearest 服務本身故障造成假性失敗。
    if(!valid.length){
      const route=await requestValhallaFlatRoute(from,to,[]);
      if(!isRouteSearchActive(searchToken))return;
      if(route&&!routeHasForbiddenNationalMain(route)){valid=[route];routingMode="Valhalla 原始座標救援";}
    }

    if(!valid.length)throw new Error(
  isQiduRow(from)
    ? "七堵目前固定從「七堵車站」出發，但仍沒有取得可驗證的道路路線；請稍後重新分析。"
    : "目前兩個 OSRM 路由服務與 Valhalla 都沒有回傳可驗證的道路路線；請稍後重新分析。"
);

    routeCandidates=valid
      .filter(route=>routeLooksPlausible(route,sf,st))
      .map(route=>routeCandidateAnalysis(route))
      .filter(x=>x.coords.length>1&&x.route.distance>0)
      .sort((a,b)=>a.route.duration-b.route.duration);
    const fast=routeCandidates[0];
    if(!fast)throw new Error("路由服務有回應，但沒有可繪製的完整道路幾何。");
    // 最快路線只負責產生並顯示最快候選；宣紙模式會在使用者點擊時重新搜尋。
    routeCandidates=[fast];
    activeRouteCandidateIndex=0;
    activeRouteEndpoints={from,to,routingMode};
    saveRouteHistoryItem(from,to);
    activateRouteCandidate(0);
  }catch(e){
    if(!isRouteSearchActive(searchToken))return;
    console.error(e);
    box.className="route-result";
    box.innerHTML="<strong>路線分析暫時失敗</strong><p class=\"route-hint\">"+e.message+"</p><p class=\"route-hint\">系統已依序嘗試：道路端點吸附 → OSRM 避開國道 → 導引點繞行 → Valhalla 機車路由 → OSRM 最終救援。</p>";
  }finally{
    if(isRouteSearchActive(searchToken)){
      stopRouteLoadingAnimation();
      button.disabled=false;
      button.textContent="分析這段路的可騎行性";
    }
  }
}
function startRouteLoadingAnimation(){
  stopRouteLoadingAnimation();
  const button=$("#analyzeRouteBtn");
  if(!button)return;
  let dots=1;
  const render=()=>{button.textContent="規劃路線中"+".".repeat(dots);dots=dots>=6?1:dots+1;};
  render();
  routeLoadingTimer=setInterval(render,420);
}
function stopRouteLoadingAnimation(){
  if(routeLoadingTimer){clearInterval(routeLoadingTimer);routeLoadingTimer=null;}
}
function clearRoute(){
  cancelActiveRouteSearch();
  clearRouteMotorcycleAnimation();
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  clearRouteEndpoints();routeCandidates=[];activeRouteCandidateIndex=0;
  const from=routeSearchElements("from"),to=routeSearchElements("to");
  [from,to].forEach(e=>{if(!e)return;e.input.value="";e.input.dataset.city="";e.input.dataset.mode="";e.input.dataset.index="-1";e.value.value="";e.suggestions.innerHTML="";e.suggestions.classList.add("hidden");e.townWrap.classList.add("hidden");e.town.innerHTML='<option value="">請先選擇縣市</option>';});
  const box=$("#routeResult");if(box){box.className="route-result hidden";box.innerHTML="";}
  const button=$("#analyzeRouteBtn");if(button){button.disabled=false;button.textContent="分析這段路的可騎行性";}
}
function normalizeDefaultLocation(value){
  if(typeof value==="string"){
    const r=cityRepresentative(value);
    return r?{city:r.city,town:r.town}:null;
  }
  if(!value||!value.city)return null;
  const city=state.rows.find(r=>r.city===value.city);
  if(!city)return null;
  const town=value.town||city.town;
  const r=state.rows.find(row=>row.city===value.city&&row.town===town);
  return r?{city:r.city,town:r.town}:null;
}
function loadDefaults(){
  try{
    const saved=JSON.parse(localStorage.getItem(DEFAULT_KEY)||"[]");
    if(Array.isArray(saved)&&saved.length){
      state.defaultLocations=saved.map(normalizeDefaultLocation).filter(Boolean).slice(0,9);
      return;
    }
    const legacy=JSON.parse(localStorage.getItem(LEGACY_DEFAULT_KEY)||"[]");
    if(Array.isArray(legacy)&&legacy.length){
      state.defaultLocations=legacy.map(normalizeDefaultLocation).filter(Boolean).slice(0,9);
      saveDefaults();
    }
  }catch(_){}
}
function saveDefaults(){
  localStorage.setItem(DEFAULT_KEY,JSON.stringify(state.defaultLocations.slice(0,9)));
  updateDefaultCount();
}
function updateDefaultCount(){
  $("#defaultCount").textContent=state.defaultLocations.length+" / 9";
}
function ensureDefaults(){
  const normalized=state.defaultLocations.map(normalizeDefaultLocation).filter(Boolean);
  state.defaultLocations=normalized.slice(0,9);
  if(!state.defaultLocations.length){
    state.defaultLocations=cities().slice(0,9).map(city=>{
      const r=cityRepresentative(city);
      return r?{city:r.city,town:r.town}:null;
    }).filter(Boolean);
  }
  saveDefaults();
}
function normalizeSearchText(value=""){
  return String(value).trim().replaceAll("臺","台").replaceAll("台灣","台灣");
}
function openDefaultCities(){
  const panel=document.querySelector(".default-cities-collapse");
  if(panel)panel.open=true;
}
function renderSuggestions(){
  const box=$("#suggestions"),q=normalizeSearchText($("#searchInput").value);
  state.suggestionItems=[];state.suggestionIndex=-1;
  if(!q){box.classList.add("hidden");$("#townSelectWrap").classList.add("hidden");return}

  const cityMatches=cities().filter(city=>normalizeSearchText(city).includes(q));
  const townMatches=state.rows.filter(r=>normalizeSearchText(r.town).includes(q));

  // 完整輸入縣市名稱：維持原本行為，顯示該縣市的鄉鎮下拉選單。
  const exactCity=cities().find(city=>normalizeSearchText(city)===q);
  if(exactCity){
    state.selectedCity=exactCity;state.selectedTown="";
    populateTownSelect(exactCity);
    $("#townSelectWrap").classList.remove("hidden");
    $("#searchHint").textContent="已輸入："+exactCity+"，請從下方下拉選單選擇該地區的鄉鎮。";
    box.classList.add("hidden");
    renderCityCards(exactCity);
    openDefaultCities();
    return;
  }

  const items=[];
  const seenCities=new Set();
  cityMatches.forEach(city=>{
    if(seenCities.has(city))return;
    seenCities.add(city);
    items.push({type:"city",city,town:"",name:city,label:"縣市"});
  });

  // 同名鄉鎮可能存在於不同縣市，因此保留每一筆，讓使用者能直接選到正確資料。
  townMatches.forEach(r=>items.push({type:"town",city:r.city,town:r.town,name:r.town,label:"鄉鎮"}));

  state.suggestionItems=items;
  box.innerHTML="";
  items.slice(0,10).forEach((m,i)=>{
    const b=document.createElement("button");
    b.type="button";b.className="suggestion";b.dataset.index=i;
    b.innerHTML="<span>"+m.name+"</span><small>"+m.label+(m.type==="town"?"｜"+m.city:"")+"</small>";
    b.addEventListener("click",()=>selectSearch(m));
    b.addEventListener("mouseenter",()=>setSuggestionIndex(i));
    box.appendChild(b);
  });
  box.classList.toggle("hidden",!items.length);
  $("#townSelectWrap").classList.add("hidden");
}
function setSuggestionIndex(index){
  const visibleCount=Math.min(state.suggestionItems.length,10);
  if(!visibleCount)return;
  state.suggestionIndex=Math.max(0,Math.min(index,visibleCount-1));
  document.querySelectorAll("#suggestions .suggestion").forEach((el,i)=>el.classList.toggle("active",i===state.suggestionIndex));
  const active=document.querySelector("#suggestions .suggestion.active");
  if(active)active.scrollIntoView({block:"nearest"});
}
function handleSearchKeydown(e){
  const box=$("#suggestions");
  if(box.classList.contains("hidden")){
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){
      const q=normalizeSearchText($("#searchInput").value);
      if(q){renderSuggestions();e.preventDefault();}
    }
    return;
  }
  const count=Math.min(state.suggestionItems.length,10);
  if(!count)return;
  if(e.key==="ArrowDown"){
    e.preventDefault();setSuggestionIndex(state.suggestionIndex<0?0:state.suggestionIndex+1);
  }else if(e.key==="ArrowUp"){
    e.preventDefault();setSuggestionIndex(state.suggestionIndex<0?count-1:state.suggestionIndex-1);
  }else if(e.key==="Enter"){
    if(state.suggestionIndex>=0){e.preventDefault();selectSearch(state.suggestionItems[state.suggestionIndex]);}
  }else if(e.key==="Escape"){
    e.preventDefault();box.classList.add("hidden");state.suggestionIndex=-1;
  }
}
function selectSearch(m,recordHistory=true){
  $("#suggestions").classList.add("hidden");
  state.suggestionIndex=-1;
  state.selectedCity=m.city;
  state.selectedTown=m.town||"";
  $("#searchInput").value=m.type==="town"?m.town:m.city;
  if(recordHistory)saveSearchHistory(m.city,m.town||"",m.type==="town"?"town":"city");

  if(m.type==="town"){
    // 搜尋到鄉鎮時直接顯示該筆資料，不需要再選一次縣市。
    $("#townSelectWrap").classList.add("hidden");
    renderTownResult(m.city,m.town);
    openDefaultCities();
    $("#searchHint").textContent="目前顯示："+m.city+"｜"+m.town+"（鄉鎮）。";
    return;
  }

  populateTownSelect(m.city);
  $("#townSelectWrap").classList.remove("hidden");
  $("#searchHint").textContent="已選擇："+m.city+"，請從下方下拉選單選擇該地區的鄉鎮。";
  renderCityCards(m.city);
  openDefaultCities();
  setTimeout(()=>{$("#townSelect").focus();},0);
}
function populateTownSelect(city,selected=""){
  const sel=$("#townSelect");sel.innerHTML='<option value="">請選擇鄉鎮</option>';
  towns(city).forEach(r=>{const o=document.createElement("option");o.value=r.town;o.textContent=r.town;if(r.town===selected)o.selected=true;sel.appendChild(o)});
}
function renderTownResult(city,town){
  const r=selectedRows().find(x=>x.city===city&&x.town===town);if(!r)return;
  state.selectedCity=city;
  state.selectedTown=town;
  openDefaultCities();
  renderRows([r],false);
  $("#searchHint").textContent="目前顯示："+city+"｜"+town+"。選擇其他鄉鎮即可切換。";
}
function renderCityCards(city){openDefaultCities();$("#weatherGrid").innerHTML="";$("#searchHint").textContent="已選擇："+city+"，請從下方下拉選單選擇鄉鎮；選擇後才會顯示該鄉鎮資料。"}
function forecastDays(r){
  const forecast=(r?.forecast||[]).filter(x=>x?.start).sort((a,b)=>new Date(a.start)-new Date(b.start));
  const days=new Map();
  for(const item of forecast){
    const d=new Date(item.start);
    const key=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
    if(!days.has(key))days.set(key,[]);
    days.get(key).push(item);
  }
  return [...days.entries()].slice(0,7).map(([key,items],index)=>{
    const temps=items.map(x=>x.temperature).filter(Number.isFinite);
    const pops=items.map(x=>x.pop).filter(Number.isFinite);
    const hums=items.map(x=>x.humidity).filter(Number.isFinite);
    const winds=items.map(x=>x.windSpeed).filter(Number.isFinite);
    const representativeWeather=items.find(x=>x.weather&&x.weather!=="資料待更新")?.weather||"資料待更新";
    const riding=ridingCondition({
      temperature:temps.length?temps.reduce((a,b)=>a+b,0)/temps.length:null,
      humidity:hums.length?hums.reduce((a,b)=>a+b,0)/hums.length:null,
      pop:pops.length?Math.max(...pops):null,
      windSpeed:winds.length?Math.max(...winds):null,
      weather:representativeWeather
    });
    return {
      key,items,index,
      dateLabel:index===0?"今天":index===1?"明天":index===2?"後天":`第${index+1}天`,
      temp:temps.length?temps.reduce((a,b)=>a+b,0)/temps.length:null,
      minTemp:temps.length?Math.min(...temps):null,
      maxTemp:temps.length?Math.max(...temps):null,
      pop:pops.length?Math.max(...pops):null,
      humidity:hums.length?hums.reduce((a,b)=>a+b,0)/hums.length:null,
      wind:winds.length?Math.max(...winds):null,
      weather:items.find(x=>x.weather&&x.weather!=="資料待更新")?.weather||"資料待更新",
      riding
    };
  });
}
function buildLineChart(days,type){
  const width=720,height=220,pad={l:48,r:24,t:30,b:42};
  const values=days.map(d=>type==="temp"?d.temp:d.pop).map(v=>Number.isFinite(v)?v:null);
  const valid=values.filter(v=>v!==null);
  if(!valid.length)return '<div class="forecast-chart-empty">目前沒有可用資料</div>';
  let min=Math.min(...valid),max=Math.max(...valid);
  if(type==="temp"){min=Math.floor(min-1);max=Math.ceil(max+1);}
  else {min=Math.max(0,Math.floor(min/10)*10);max=Math.min(100,Math.ceil(max/10)*10);if(min===max){min=Math.max(0,min-10);max=Math.min(100,max+10);}}
  if(min===max){min-=1;max+=1;}
  const x=i=>pad.l+(days.length===1?0:i*(width-pad.l-pad.r)/(days.length-1));
  const y=v=>pad.t+(max-v)*(height-pad.t-pad.b)/(max-min);
  const points=values.map((v,i)=>v===null?null:`${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(" ");
  const unit=type==="temp"?"°C":"%";
  const title=type==="temp"?"🌡️ 溫度變化":"🌧️ 降雨機率變化";
  const labels=days.map((d,i)=>`<text x="${x(i)}" y="${height-14}" text-anchor="middle" class="forecast-chart-label">${d.dateLabel}</text>`).join("");
  const dots=values.map((v,i)=>v===null?"":`<circle cx="${x(i)}" cy="${y(v)}" r="4" class="forecast-chart-dot"><title>${days[i].dateLabel}：${v.toFixed(0)}${unit}</title></circle>`).join("");
  const guides=[0,.5,1].map(t=>{const value=max-(max-min)*t;return `<line x1="${pad.l}" x2="${width-pad.r}" y1="${y(value)}" y2="${y(value)}" class="forecast-chart-grid"/><text x="${pad.l-9}" y="${y(value)+4}" text-anchor="end" class="forecast-chart-y">${value.toFixed(0)}${unit}</text>`;}).join("");
  const trendLabel=type==="pop"?"4 日趨勢":"7 日趨勢";
  return `<div class="forecast-chart"><div class="forecast-chart-title"><strong>${title}</strong><span>${trendLabel}</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><g>${guides}</g><polyline points="${points}" class="forecast-chart-line" fill="none" stroke-linecap="round" stroke-linejoin="round"></polyline><g>${dots}</g><g>${labels}</g></svg></div>`;
}
function renderThreeDayForecast(container,r){
  container.innerHTML="";
  const days=forecastDays(r);
  if(!days.length){container.innerHTML='<p class="muted">目前沒有可用的 7 日預報資料。</p>';return;}
  const rainChartDays=days.slice(0,4);
  container.innerHTML='<div class="forecast-charts">'+buildLineChart(days,"temp")+buildLineChart(rainChartDays,"pop")+'</div><p class="forecast-rain-window-note">🌧️ 降雨機率趨勢圖聚焦未來 4 天：RideSky 為降低較遠期降雨預報變動造成的誤判，只在折線圖呈現前 4 天；第 5–7 天仍保留於下方每日預報卡，供趨勢參考。</p><div class="forecast-day-list">'+
    days.map(d=>'<div class="three-day-item '+(d.riding?.level||"good")+'"><div class="three-day-head"><strong>'+d.dateLabel+'</strong><span>'+d.key+'</span></div><div class="three-day-weather">'+icon(d.weather)+' '+d.weather+'</div><div class="three-day-values"><span>🌡️ '+(d.minTemp!=null?d.minTemp+"–"+d.maxTemp:"--")+' °C</span><span>🌧️ 降雨機率 '+(d.pop!=null?d.pop:"--")+' %</span><span>💧 濕度 '+(d.humidity!=null?d.humidity.toFixed(0):"--")+' %</span><span>💨 最高風速 '+(d.wind!=null?d.wind.toFixed(1):"--")+' m/s</span></div><div class="three-day-riding"><span>🏍️ 騎乘條件</span><strong>'+((d.riding?.icon)||"")+" "+((d.riding?.label)||"資料不足")+(d.riding?.incomplete?"":" · "+(Number.isFinite(d.riding?.score)?d.riding.score:"--")+" / 5")+'</strong></div><div class="three-day-riding-reasons">'+(d.riding?.reasons?.length?d.riding.reasons.join("、"):"目前沒有明顯不利因素")+'</div></div>').join("")+
    '</div>';
}
function bindForecastCollapse(details){
  if(!details)return;
  details.addEventListener("toggle",()=>{
    if(details.open)document.querySelectorAll(".three-day-collapse[open]").forEach(other=>{if(other!==details)other.open=false;});
    const card=details.closest(".weather-card");
    if(!card)return;
    card.classList.toggle("forecast-expanded",details.open);
    if(details.open){
      requestAnimationFrame(()=>{
        const charts=details.querySelectorAll(".forecast-chart");
        charts.forEach((chart,i)=>{
          chart.style.animation="none";
          void chart.offsetWidth;
          chart.style.animation="";
          chart.style.animationDelay=(i*70)+"ms";
        });
      });
    }
  });
}
function buildWeatherCardFragment(r,{routeInline=false}={}){
  const t=$("#weatherTemplate");
  const n=t.content.cloneNode(true),check=n.querySelector(".default-check");
  const card=n.querySelector(".weather-card");
  if(routeInline&&card)card.classList.add("route-inline-weather-card");

  n.querySelector(".city").textContent=r.town;
  n.querySelector(".town").textContent=r.city;
  n.querySelector(".weather-icon").textContent=icon(r.weather);
  n.querySelector(".temp").textContent=fmt(r.temperature);
  n.querySelector(".weather-name").textContent=r.weather;
  n.querySelector(".humidity").textContent=fmt(r.humidity,"%");
  n.querySelector(".pop").textContent=fmt(r.pop,"%");
  n.querySelector(".wind-direction").textContent=windArrow(r.windDirection)+" "+(r.windDirection||"--");
  n.querySelector(".wind-speed").textContent=fmt(r.windSpeed," m/s");

  const riding=r.riding||ridingCondition(r);
  const decision=buildDecisionSupport(r);
  const levelEl=n.querySelector(".riding-level");
  const panel=n.querySelector(".riding-panel");
  levelEl.textContent=(riding.icon||"")+" "+(riding.label||"資料不足");
  panel.className="riding-panel riding-"+(riding.level||"unknown");
  n.querySelector(".riding-score-value").textContent=Number.isFinite(riding.score)?riding.score:"--";
  n.querySelector(".riding-reasons-value").textContent=riding.reasons?.length?riding.reasons.join("、"):"目前沒有明顯不利因素";
  n.querySelector(".riding-advice-value").textContent=riding.advice||"請留意最新天氣資訊。";
  const rainGearEl=n.querySelector(".rain-gear-value");
  if(rainGearEl)rainGearEl.textContent=(riding.rainGear||"資料不足")+(riding.rainRisk?"（降雨風險："+riding.rainRisk+"）":"");
  const decisionPanel=n.querySelector(".decision-panel");
  decisionPanel.className="decision-panel decision-"+decision.action.toLowerCase();
  n.querySelector(".decision-action").textContent=decision.actionIcon+" "+decision.actionLabel;
  n.querySelector(".decision-evidence").textContent=decision.evidence.join("、");
  n.querySelector(".forecast-time").textContent=r.start?"預報時間："+formatTaiwanDateTime(r.start):"預報時間：--";

  renderThreeDayForecast(n.querySelector(".three-day-forecast"),r);
  bindForecastCollapse(n.querySelector(".three-day-collapse"));

  const defaultLocation=state.defaultLocations.some(d=>d.city===r.city&&d.town===r.town);
  check.checked=defaultLocation;
  const defaultLimitReached=state.defaultLocations.length>=9&&!defaultLocation;
  check.disabled=defaultLimitReached;
  if(defaultLimitReached){
    check.title="預設顯示已達 9 個上限，請先取消其他預設地區。";
    check.setAttribute("aria-label",r.city+"｜"+r.town+"：預設顯示已達 9 個上限");
  }else{
    check.removeAttribute("title");
    check.removeAttribute("aria-label");
  }

  check.addEventListener("click",event=>event.stopPropagation());
  check.addEventListener("change",()=>{
    if(check.checked&&!defaultLocation&&state.defaultLocations.length>=9){
      check.checked=false;
      alert("預設顯示最多 9 個地區，請先取消其他預設地區。");
      return;
    }
    toggleDefault(r.city,r.town,check.checked);
  });

  return n;
}
function renderRows(rows,showAll=false){
  const g=$("#weatherGrid");
  g.innerHTML="";
  if(!rows.length){
    g.innerHTML='<div class="source-card"><strong>沒有符合的資料</strong><p>請重新搜尋或清除選擇。</p></div>';
    return;
  }
  rows.forEach(r=>g.appendChild(buildWeatherCardFragment(r)));
}
function routePointFullWeatherRow(r){
  if(!r)return null;
  const base=state.rows.find(x=>x.city===r.city&&x.town===r.town);
  if(!base)return r;
  const dated=rowForDate(base,routeDateValue())||r;
  const full={
    ...dated,
    city:base.city,
    town:base.town,
    latitude:base.latitude,
    longitude:base.longitude,
    forecast:base.forecast||[]
  };
  full.riding=ridingCondition(full);
  return full;
}
function renderRoutePointExpandedWeather(container,row){
  if(!container)return;
  container.innerHTML="";
  const fullRow=routePointFullWeatherRow(row);
  if(!fullRow){
    container.innerHTML='<div class="route-point-detail-empty">目前沒有可顯示的完整氣象資料。</div>';
    return;
  }
  container.appendChild(buildWeatherCardFragment(fullRow,{routeInline:true}));
}
function bindRoutePointExpanders(box,analysis){
  if(!box||!analysis)return;
  box.querySelectorAll(".route-point[data-route-point-index]").forEach(point=>{
    const toggle=()=>{
      const index=Number(point.dataset.routePointIndex);
      const item=analysis.nearby[index];
      const entry=point.closest(".route-point-entry");
      const detail=entry?.querySelector(".route-point-expanded");
      if(!detail||!item)return;
      const opening=detail.classList.contains("hidden");
      detail.classList.toggle("hidden",!opening);
      point.classList.toggle("is-expanded",opening);
      point.setAttribute("aria-expanded",opening?"true":"false");
      const hint=point.querySelector(".route-point-expand-hint");
      if(hint)hint.textContent=opening?"收合完整天氣 −":"查看完整天氣 ＋";
      if(opening&&!detail.hasChildNodes())renderRoutePointExpandedWeather(detail,item.row);
    };
    point.addEventListener("click",toggle);
    point.addEventListener("keydown",event=>{
      if(event.key==="Enter"||event.key===" "){
        event.preventDefault();
        toggle();
      }
    });
  });
}
function toggleDefault(city,town,on){
  const key=city+"||"+town;
  if(on){
    if(state.defaultLocations.some(d=>d.city+"||"+d.town===key))return;
    if(state.defaultLocations.length>=9){
      alert("預設顯示最多 9 個地區，請先取消其他預設地區。");
      renderDefaultCards();
      return;
    }
    state.defaultLocations.push({city,town});
  }else{
    state.defaultLocations=state.defaultLocations.filter(d=>d.city!==city||d.town!==town);
  }
  saveDefaults();
  // 預設地區變更後，立即同步地圖上的預設標記與數量。
  if(taiwanMap)renderTaiwanMap();
  if(on&&state.selectedCity===city&&state.selectedTown===town)clearSearch();
  else renderDefaultCards();
}
function renderDefaultCards(){
  const rows=selectedRows(state.defaultLocations.map(d=>state.rows.find(r=>r.city===d.city&&r.town===d.town)).filter(Boolean));
  renderRows(rows,true);
  $("#searchHint").textContent="勾選「預設」即可讓該縣市／鄉鎮在下次開啟網頁時自動出現；最多 9 個。";
}
function clearSearch(){
  state.selectedCity="";state.suggestionItems=[];state.suggestionIndex=-1;state.selectedTown="";$("#searchInput").value="";$("#townSelect").innerHTML='<option value="">請先選擇縣市</option>';$("#townSelectWrap").classList.add("hidden");$("#suggestions").classList.add("hidden");renderDefaultCards();
}
function loadSearchHistory(){
  try{
    const x=JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY)||"[]");
    return Array.isArray(x)?x.slice(0,10):[];
  }catch(_){return [];}
}
function renderSearchHistory(){
  const box=$("#searchHistoryList");if(!box)return;
  const history=loadSearchHistory();
  if(!history.length){
    box.innerHTML='<div class="route-history-empty">尚無歷史搜尋紀錄。</div>';
    return;
  }
  box.innerHTML=history.map((h,i)=>{
    const d=h.time?new Date(h.time):null;
    const tm=d&&!Number.isNaN(d.getTime())?formatTaiwanDateTime(d):"--";
    const label=h.type==="town"?"鄉鎮":"縣市";
    const name=h.type==="town"?(h.city+"｜"+h.town):h.city;
    return '<button type="button" class="route-history-item search-history-item" data-search-history-index="'+i+'"><div><div class="route-history-route">'+name+'<small class="search-history-type">'+label+'</small></div><span class="route-history-time">'+tm+'</span></div><span class="route-history-arrow">›</span></button>';
  }).join("");
  box.querySelectorAll(".search-history-item").forEach(btn=>btn.addEventListener("click",()=>{
    const h=history[Number(btn.dataset.searchHistoryIndex)];
    if(!h)return;
    const r=h.city&&h.town?state.rows.find(x=>x.city===h.city&&x.town===h.town):null;
    if(h.type==="town"&&r){
      selectSearch({type:"town",city:h.city,town:h.town,name:h.town,label:"鄉鎮"},false);
    }else if(h.city){
      selectSearch({type:"city",city:h.city,town:"",name:h.city,label:"縣市"},false);
    }
    const details=btn.closest(".route-history-collapse");
    if(details)details.open=false;
  }));
}
function saveSearchHistory(city,town="",type="city"){
  if(!city)return;
  const key=type+"||"+city+"||"+town;
  const history=loadSearchHistory().filter(h=>(h.type||"city")+"||"+(h.city||"")+"||"+(h.town||"")!==key);
  history.unshift({city,town,type,time:Date.now()});
  try{localStorage.setItem(SEARCH_HISTORY_KEY,JSON.stringify(history.slice(0,10)));}catch(_){}
  renderSearchHistory();
}
function summary(){
  const ts=state.rows.map(r=>r.temperature).filter(Number.isFinite),hs=state.rows.map(r=>r.humidity).filter(Number.isFinite);
  $("#cityCount").textContent=cities().length;$("#recordCount").textContent=state.rows.length;
  $("#avgTemp").textContent=ts.length?(ts.reduce((a,b)=>a+b,0)/ts.length).toFixed(1)+" °C":"--";
  $("#avgHumidity").textContent=hs.length?(hs.reduce((a,b)=>a+b,0)/hs.length).toFixed(1)+" %":"--";
}
let taiwanMap=null;
let weatherMarkers=[];
let routeEndpointMarkers=[];
let routeLayer=null;
let routeCandidates=[];
let activeRouteCandidateIndex=0;
let activeRouteEndpoints=null;
let routeAvoidanceSearching=false;
let routeSearchGeneration=0;
const routeAbortControllers=new Set();
const ROUTE_HISTORY_KEY="rideskyRouteHistoryV1";

function cancelActiveRouteSearch(){
  routeSearchGeneration++;
  for(const controller of routeAbortControllers){
    try{controller.abort();}catch(_){}
  }
  routeAbortControllers.clear();
  routeAvoidanceSearching=false;
  stopRouteLoadingAnimation();
}
function beginRouteSearch(){
  cancelActiveRouteSearch();
  return routeSearchGeneration;
}
function isRouteSearchActive(token){
  return token===routeSearchGeneration;
}
function createRouteAbortController(timeoutMs){
  const controller=new AbortController();
  routeAbortControllers.add(controller);
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return {
    controller,
    done(){
      clearTimeout(timer);
      routeAbortControllers.delete(controller);
    }
  };
}
let routeMotorcycleMarker=null;
let routeAnimationFrame=null;
let routeAnimationRestartTimer=null;
let routeAnimationToken=0;

function clearRouteMotorcycleAnimation(){
  routeAnimationToken++;
  if(routeAnimationFrame!=null)cancelAnimationFrame(routeAnimationFrame);
  routeAnimationFrame=null;
  if(routeAnimationRestartTimer!=null)clearTimeout(routeAnimationRestartTimer);
  routeAnimationRestartTimer=null;
  if(routeMotorcycleMarker&&taiwanMap){
    taiwanMap.removeLayer(routeMotorcycleMarker);
  }
  routeMotorcycleMarker=null;
}

function routeDistance(a,b){
  const R=6371000,rad=Math.PI/180;
  const dLat=(b[0]-a[0])*rad,dLng=(b[1]-a[1])*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function routeBearing(a,b){
  const rad=Math.PI/180;
  const lat1=a[0]*rad,lat2=b[0]*rad,dLng=(b[1]-a[1])*rad;
  const y=Math.sin(dLng)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLng);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

function startRouteMotorcycleAnimation(coords){
  clearRouteMotorcycleAnimation();
  if(!taiwanMap||!Array.isArray(coords)||coords.length<2)return;
  const token=routeAnimationToken,points=[];let total=0;
  for(let i=0;i<coords.length;i++){if(i>0)total+=routeDistance(coords[i-1],coords[i]);points.push({lat:coords[i][0],lng:coords[i][1],distance:total});}
  if(total<=0)return;
  const icon=L.divIcon({className:"route-motorcycle-marker",html:"<span>🏍️</span>",iconSize:[34,34],iconAnchor:[17,17]});
  routeMotorcycleMarker=L.marker([points[0].lat,points[0].lng],{icon,zIndexOffset:1000,interactive:false}).addTo(taiwanMap);
  const duration=Math.min(30000,Math.max(7000,total/90*1000));
  let start=performance.now(),phase="forward";
  function setPoint(target){
    let i=1;while(i<points.length&&points[i].distance<target)i++;if(i>=points.length)i=points.length-1;
    const a=points[i-1],b=points[i],span=Math.max(1,b.distance-a.distance),local=Math.min(1,Math.max(0,(target-a.distance)/span));
    routeMotorcycleMarker.setLatLng([a.lat+(b.lat-a.lat)*local,a.lng+(b.lng-a.lng)*local]);
    const bearing=routeBearing([a.lat,a.lng],[b.lat,b.lng]),el=routeMotorcycleMarker.getElement()?.querySelector("span");
    if(el)el.style.transform="rotate("+(bearing+90)+"deg)";
  }
  function flyBack(now){
    const progress=Math.min(1,(now-start)/1200),eased=progress<.5?2*progress*progress:1-Math.pow(-2*progress+2,2)/2;
    const end=points[points.length-1],first=points[0];
    routeMotorcycleMarker.setLatLng([end.lat+(first.lat-end.lat)*eased,end.lng+(first.lng-end.lng)*eased]);
    const el=routeMotorcycleMarker.getElement()?.querySelector("span");if(el)el.style.transform="rotate(-90deg) scale("+(1+0.08*Math.sin(progress*Math.PI))+")";
    if(progress<1){routeAnimationFrame=requestAnimationFrame(flyBack);return;}
    routeAnimationFrame=null;routeMotorcycleMarker.setLatLng([first.lat,first.lng]);phase="forward";start=performance.now();routeAnimationFrame=requestAnimationFrame(frame);
  }
  function frame(now){
    if(token!==routeAnimationToken||!routeMotorcycleMarker)return;
    if(phase==="return"){flyBack(now);return;}
    const progress=Math.min(1,(now-start)/duration);setPoint(total*progress);
    if(progress<1){routeAnimationFrame=requestAnimationFrame(frame);return;}
    routeAnimationFrame=null;setPoint(total);
    routeAnimationRestartTimer=setTimeout(()=>{routeAnimationRestartTimer=null;if(token!==routeAnimationToken||!routeMotorcycleMarker)return;phase="return";start=performance.now();routeAnimationFrame=requestAnimationFrame(frame);},5000);
  }
  routeAnimationFrame=requestAnimationFrame(frame);
}
function weatherMarkerStyle(r){
  const riding=r?.riding||ridingCondition(r);
  const level=riding?.level||"normal";
  const styles={
    good:{fillColor:"#22c55e",color:"#bbf7d0"},
    normal:{fillColor:"#facc15",color:"#fef08a"},
    caution:{fillColor:"#f97316",color:"#fed7aa"},
    high:{fillColor:"#ef4444",color:"#fecaca"}
  };
  const style=styles[level]||styles.normal;
  return {radius:8,...style};
}

function cartoKeyUrl(url,key){
  const separator=url.includes("?")?"&":"?";
  return url+separator+"key="+encodeURIComponent(key);
}

function customizeRideSkyStyle(style,key){
  const custom=JSON.parse(JSON.stringify(style));
  custom.name="RideSky Vector Basemap";
  custom.sources=custom.sources||{};
  Object.values(custom.sources).forEach(source=>{
    if(source&&typeof source.url==="string")source.url=cartoKeyUrl(source.url,key);
  });
  if(custom.sprite)custom.sprite=cartoKeyUrl(custom.sprite,key);
  if(custom.glyphs)custom.glyphs=cartoKeyUrl(custom.glyphs,key);

  const colors={
    background:"#071522",
    land:"#0b1d2b",
    park:"#0d2631",
    water:"#0a2f4a",
    waterway:"#1c6682",
    boundary:"#29485e",
    motorway:"#6f9bb5",
    trunk:"#5f8ca6",
    primary:"#4f7890",
    secondary:"#3c5e73",
    tertiary:"#304d61",
    minor:"#263f52",
    service:"#203747",
    path:"#24485d",
    rail:"#35566b",
    building:"#102536",
    text:"#b9d3e2",
    textStrong:"#d8e8f2",
    textHalo:"#071522"
  };

  for(const layer of custom.layers||[]){
    const sourceLayer=layer["source-layer"]||"";
    const id=String(layer.id||"");
    const filter=JSON.stringify(layer.filter||[]);
    layer.paint=layer.paint||{};

    if(layer.type==="background"){
      layer.paint["background-color"]=colors.background;
      continue;
    }

    if(layer.type==="fill"||layer.type==="fill-extrusion"){
      if(sourceLayer==="water")layer.paint["fill-color"]=colors.water;
      else if(sourceLayer==="landcover"||sourceLayer==="park")layer.paint["fill-color"]=colors.park;
      else if(sourceLayer==="landuse")layer.paint["fill-color"]=colors.land;
      else if(sourceLayer==="building")layer.paint["fill-color"]=colors.building;
      continue;
    }

    if(layer.type==="line"){
      if(sourceLayer==="waterway")layer.paint["line-color"]=colors.waterway;
      else if(sourceLayer==="boundary"){
        layer.paint["line-color"]=colors.boundary;
        layer.paint["line-opacity"]=0.55;
      }else if(sourceLayer==="transportation"){
        let road=colors.minor;
        if(filter.includes('"motorway"'))road=colors.motorway;
        else if(filter.includes('"trunk"'))road=colors.trunk;
        else if(filter.includes('"primary"'))road=colors.primary;
        else if(filter.includes('"secondary"'))road=colors.secondary;
        else if(filter.includes('"tertiary"'))road=colors.tertiary;
        else if(filter.includes('"service"'))road=colors.service;
        else if(filter.includes('"path"'))road=colors.path;
        else if(filter.includes('"rail"'))road=colors.rail;
        if(id.includes("_case"))road="#12293a";
        layer.paint["line-color"]=road;
      }else if(sourceLayer==="aeroway"){
        layer.paint["line-color"]="#29485e";
      }
      continue;
    }

    if(layer.type==="symbol"){
      if(layer.paint["text-color"]!==undefined)layer.paint["text-color"]=sourceLayer==="place"?colors.textStrong:colors.text;
      if(layer.paint["text-halo-color"]!==undefined)layer.paint["text-halo-color"]=colors.textHalo;
      if(layer.paint["icon-color"]!==undefined)layer.paint["icon-color"]="#6f93a8";
      if(sourceLayer==="poi"){
        if(layer.paint["text-opacity"]===undefined)layer.paint["text-opacity"]=0.62;
        if(layer.paint["icon-opacity"]===undefined)layer.paint["icon-opacity"]=0.55;
      }
    }
  }
  return custom;
}

let mapLibrePromise=null;
function loadMapLibreAssets(){
  if(window.maplibregl&&L.maplibreGL)return Promise.resolve();
  if(mapLibrePromise)return mapLibrePromise;
  mapLibrePromise=new Promise((resolve,reject)=>{
    const css=document.createElement("link");
    css.rel="stylesheet";
    css.href="https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css";
    document.head.appendChild(css);

    const mapScript=document.createElement("script");
    mapScript.src="https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js";
    mapScript.onload=()=>{
      const bridge=document.createElement("script");
      bridge.src="https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js";
      bridge.onload=resolve;
      bridge.onerror=()=>reject(new Error("MapLibre Leaflet 整合套件載入失敗。"));
      document.head.appendChild(bridge);
    };
    mapScript.onerror=()=>reject(new Error("MapLibre GL 載入失敗。"));
    document.head.appendChild(mapScript);
  });
  return mapLibrePromise;
}

async function getRideSkyVectorStyle(key){
  const cacheKey="rideskyVectorStyleV1";
  try{
    const cached=JSON.parse(localStorage.getItem(cacheKey)||"null");
    if(cached?.style?.version&&cached?.savedAt&&Date.now()-cached.savedAt<86400000){
      return customizeRideSkyStyle(cached.style,key);
    }
  }catch(_){}
  const styleUrl=cartoKeyUrl("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",key);
  const response=await fetch(styleUrl,{cache:"force-cache"});
  if(!response.ok)throw new Error("CARTO Vector Basemap 載入失敗（HTTP "+response.status+"）。");
  const style=await response.json();
  try{localStorage.setItem(cacheKey,JSON.stringify({savedAt:Date.now(),style}));}catch(_){}
  return customizeRideSkyStyle(style,key);
}

async function initTaiwanMap(){
  if(taiwanMap||typeof L==="undefined")return;
  const key=loadCartoBasemapKey();
  await loadMapLibreAssets();
  const style=await getRideSkyVectorStyle(key);

  taiwanMap=L.map("taiwanMap",{
    zoomControl:true,
    preferCanvas:true,
    minZoom:5,
    maxZoom:18,
    maxBounds:[[21.5,118.0],[26.5,123.0]],
    maxBoundsViscosity:0.9
  }).setView([23.7,121.0],7);

  L.maplibreGL({
    style,
    interactive:false,
    attribution:"&copy; OpenStreetMap contributors, &copy; CARTO"
  }).addTo(taiwanMap);
}

let mapLoadScheduled=false;
function lazyLoadTaiwanMap(){
  if(mapLoadScheduled||taiwanMap)return;
  mapLoadScheduled=true;
  const target=document.getElementById("taiwanMap");
  if(!target){
    mapLoadScheduled=false;
    return;
  }
  if("IntersectionObserver" in window){
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){
        observer.disconnect();
        renderTaiwanMap();
      }
    },{rootMargin:"600px 0px"});
    observer.observe(target);
  }else{
    setTimeout(()=>renderTaiwanMap(),300);
  }
}

async function renderTaiwanMap(){
  try{
    await initTaiwanMap();
  }catch(error){
    console.error("RideSky Vector Basemap 載入失敗",error);
    $("#mapCount").textContent="地圖載入失敗，請稍後重試";
    return;
  }
  if(!taiwanMap)return;
  weatherMarkers.forEach(m=>m.remove());
  weatherMarkers=[];
  const defaults=selectedRows(state.defaultLocations.map(d=>state.rows.find(r=>r.city===d.city&&r.town===d.town)).filter(r=>r&&Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)));
  $("#mapCount").textContent=defaults.length+" 個預設地區";
  defaults.forEach(r=>{
    const s=weatherMarkerStyle(r);
    const riding=r.riding||ridingCondition(r);
    const marker=L.circleMarker([r.latitude,r.longitude],{
      radius:s.radius,fillColor:s.fillColor,color:s.color,weight:1.5,fillOpacity:.82
    }).addTo(taiwanMap);
    marker.bindPopup('<div class="weather-popup"><h4>'+r.city+"｜"+r.town+'</h4><div class="weather-temp">'+fmt(r.temperature," °C")+'</div><p>💧 濕度：'+fmt(r.humidity," %")+'</p><p>🌧️ 降雨機率：'+fmt(r.pop," %")+'</p><p>💨 風向：'+(r.windDirection||"--")+'</p><p>💨 風速：'+fmt(r.windSpeed," m/s")+'</p><p><strong>🏍️ 騎乘條件：'+(riding.icon||"")+" "+(riding.label||"--")+'</strong></p><p>評分：'+(Number.isFinite(riding.score)?riding.score:"--")+'</p><p>☔ 雨具建議：'+(riding.rainGear||"--")+'</p><p class="popup-muted">'+(riding.reasons?.length?"主要因素："+riding.reasons.join("、")+"<br>":"")+(riding.advice||"")+'</p></div>');
    weatherMarkers.push(marker);
  });
  if(defaults.length){
    const bounds=L.latLngBounds(defaults.map(r=>[r.latitude,r.longitude]));
    taiwanMap.fitBounds(bounds.pad(.12));
  }else{
    taiwanMap.setView([23.7,121.0],7);
  }
  if(activeRouteEndpoints)renderRouteEndpoints(activeRouteEndpoints.from,activeRouteEndpoints.to);
  setTimeout(()=>taiwanMap.invalidateSize(),100);
}

function status(a,b){$("#statusTitle").textContent=a;$("#statusText").textContent=b}
async function loadWeather(){
  status("正在取得資料…","正在透過網站後端連線至中央氣象署。");
  const statusEl=$("#refreshStatus"),actionEl=$("#refreshAction");
  actionEl.disabled=true;
  statusEl.textContent="取得資料中......";
  statusEl.classList.remove("is-success");
  try{
    const res=await fetch(API_URL),data=await res.json().catch(()=>null);
    if(!res.ok)throw new Error(data?.message||data?.result?.message||("HTTP "+res.status));
    if(data?.success===false)throw new Error(data?.result?.message||data?.message||"CWA API 回傳錯誤");
    state.rows=parseRows(data);
    // 日期選單直接使用 API 明確提供的 7 個預報日期；若舊版 API 尚未提供，
    // 再從實際回傳的 SQLite forecast rows 推導，避免日期選單空白。
    const apiDates=Array.isArray(data?.meta?.forecastDates)
      ? data.meta.forecastDates.map(String).filter(Boolean)
      : [];
    const rowDates=[...new Set(
      state.rows.flatMap(r=>(r.forecast||[]).map(item=>taiwanDateKey(item.start))).filter(Boolean)
    )].sort();
    const todayKey=todayTaiwan();
    const futureDates=rowDates.filter(key=>key>=todayKey).slice(0,7);
    const fallbackDates=apiDates.length===7?apiDates:futureDates;
    state.forecastDates=fallbackDates.length===7?fallbackDates:[];
    if(!state.forecastDates.length){
      console.warn("預報日期建立失敗：API meta 與 SQLite rows 都沒有 7 個有效日期。",{
        apiDates,rowDates
      });
    }
    populateForecastDateSelect();
    populateRouteDateSelect();
    if(!state.rows.length)throw new Error("API 有回應，但沒有可顯示的預報資料。");
    loadDefaults();ensureDefaults();summary();renderDefaultCards();populateRouteSelects();populateRouteDateSelect();
    lazyLoadTaiwanMap();
    $("#updatedAt").textContent=formatTaiwanDateTime(new Date());
    status("資料取得成功","目前取得 "+state.rows.length+" 筆鄉鎮資料，可搜尋縣市或鄉鎮。");
    statusEl.textContent="取得成功 ✓";
    statusEl.classList.add("is-success");
    actionEl.disabled=false;
    actionEl.textContent="重新取得資料";
    clearTimeout(window.__refreshButtonTimer);
    window.__refreshButtonTimer=setTimeout(()=>{
      statusEl.textContent="取得成功 ✓";
      statusEl.classList.remove("is-success");
      actionEl.disabled=false;
      actionEl.textContent="重新取得資料";
    },5000);
  }catch(e){
    console.error(e);
    status("取得資料失敗",e.message);
    statusEl.textContent="取得失敗";
    statusEl.classList.remove("is-success");
    actionEl.disabled=false;
    actionEl.textContent="重新取得資料";
  }
}
$("#refreshAction").addEventListener("click",loadWeather);
$("#searchInput").addEventListener("input",renderSuggestions);
$("#searchInput").addEventListener("keydown",handleSearchKeydown);
$("#townSelect").addEventListener("change",e=>{
  if(!state.selectedCity)return;
  if(e.target.value){
    saveSearchHistory(state.selectedCity,e.target.value,"town");
    renderTownResult(state.selectedCity,e.target.value);
    openDefaultCities();
  }else renderCityCards(state.selectedCity);
});
$("#clearSearchBtn").addEventListener("click",clearSearch);
renderSearchHistory();
$("#forecastDateSelect").addEventListener("change",e=>{
  state.selectedDate=e.target.value||todayTaiwan();
  refreshSelectedDateView();
});
$("#routeDateSelect").addEventListener("change",e=>{state.routeDate=e.target.value||todayTaiwan();if(activeRouteEndpoints)analyzeRoute();});
$("#analyzeRouteBtn").addEventListener("click",analyzeRoute);
$("#clearRouteBtn").addEventListener("click",clearRoute);
renderRouteHistory();
document.addEventListener("click",e=>{if(!e.target.closest(".search-field"))$("#suggestions").classList.add("hidden")});
window.addEventListener("load",loadWeather);